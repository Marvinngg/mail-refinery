#!/usr/bin/env node

/**
 * 263 邮件增量同步服务
 *
 * 从 263 IMAP 拉取邮件 → 清洗 → 存入 SQLite
 * 复用 263-mail MCP 项目已验证的 IMAP 代码逻辑
 */

const { ImapFlow } = require('imapflow');
const { initDB } = require('./schema');
const { splitReplyBody } = require('./split-replies');
const config = require('./config.json');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 从 263-mail MCP 项目复用的核心函数
// ---------------------------------------------------------------------------

/** 遍历 bodyStructure 找到指定 MIME 类型的 part 编号 */
function findPartByType(node, targetType) {
  if (!node) return undefined;
  if (node.type === targetType && node.disposition !== 'attachment') {
    return node.part || '1';
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const found = findPartByType(child, targetType);
      if (found) return found;
    }
  }
  return undefined;
}

/** 从 bodyStructure 提取附件元信息 */
function extractAttachments(bodyStructure) {
  const attachments = [];
  if (!bodyStructure) return attachments;

  if (bodyStructure.disposition === 'attachment') {
    const params = bodyStructure.dispositionParameters || bodyStructure.parameters || {};
    attachments.push({
      filename: params.filename || params.name || 'unnamed',
      mimeType: bodyStructure.type || 'application/octet-stream',
      size: bodyStructure.size || 0,
      part: bodyStructure.part
    });
  }

  if (bodyStructure.childNodes) {
    for (const child of bodyStructure.childNodes) {
      attachments.push(...extractAttachments(child));
    }
  }
  return attachments;
}

/** 下载指定 part 的内容 */
async function downloadPart(client, uid, partId) {
  try {
    const dl = await client.download(String(uid), partId, { uid: true });
    if (!dl?.content) return undefined;
    const chunks = [];
    for await (const chunk of dl.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 正文清洗
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 如果只有 HTML body，转成纯文本。其他情况直接返回原文。 */
function getTextBody(textBody, htmlBody) {
  if (textBody) return textBody;
  if (htmlBody) return stripHtml(htmlBody);
  return '';
}

// ---------------------------------------------------------------------------
// thread_id 计算
// ---------------------------------------------------------------------------

function computeThreadId(db, messageId, inReplyTo, references) {
  if (references) {
    // References 头的第一个就是对话的起始邮件
    const firstRef = references.split(/\s+/)[0];
    if (firstRef) return firstRef;
  }
  if (inReplyTo) {
    const parent = db.prepare('SELECT thread_id FROM emails WHERE message_id = ?').get(inReplyTo);
    if (parent) return parent.thread_id;
    return inReplyTo;
  }
  return messageId;
}

// ---------------------------------------------------------------------------
// 主同步逻辑
// ---------------------------------------------------------------------------

async function sync() {
  const db = initDB();
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] 开始同步...`);

  const client = new ImapFlow({
    host: config.account.imap.host,
    port: config.account.imap.port,
    secure: config.account.imap.tls,
    auth: {
      user: config.account.email,
      pass: config.account.password
    },
    logger: false
  });

  await client.connect();
  console.log('IMAP 连接成功');

  // 1. 同步文件夹列表
  const mailboxes = await client.list();
  const skipFolders = new Set(config.sync.folders_skip);

  const upsertFolder = db.prepare(`
    INSERT INTO folders (path, name, special_use, parent_path, synced_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET synced_at = datetime('now')
  `);

  for (const mb of mailboxes) {
    if (skipFolders.has(mb.path) || skipFolders.has(mb.name)) continue;
    const parentPath = mb.path.includes('/') ? mb.path.split('/').slice(0, -1).join('/') : null;
    upsertFolder.run(mb.path, mb.name, mb.specialUse || null, parentPath);
  }

  const foldersToSync = mailboxes.filter(mb => !skipFolders.has(mb.path) && !skipFolders.has(mb.name));
  console.log(`同步文件夹: ${foldersToSync.map(f => f.path).join(', ')}`);

  // 2. 准备 statements
  const getSyncState = db.prepare('SELECT last_uid FROM sync_state WHERE folder = ?');
  const upsertSyncState = db.prepare(`
    INSERT INTO sync_state (folder, last_uid, last_sync)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(folder) DO UPDATE SET last_uid = ?, last_sync = datetime('now')
  `);

  const insertEmail = db.prepare(`
    INSERT OR IGNORE INTO emails (
      uid, folder, message_id, in_reply_to, thread_id,
      from_addr, from_name, to_addrs, cc_addrs,
      subject, date, body_raw,
      has_attachment, attachments
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTurn = db.prepare(`
    INSERT INTO email_turns (email_id, turn_index, from_name, from_addr, date, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let totalSynced = 0;

  // 3. 对每个文件夹做增量同步
  for (const mb of foldersToSync) {
    const folderPath = mb.path;
    const state = getSyncState.get(folderPath);
    let lastUid = state?.last_uid || 0;

    // 首次同步: 只拉最近 N 天
    let searchCriteria;
    if (lastUid === 0) {
      const sinceDays = config.sync.initial_days || 3;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - sinceDays);
      searchCriteria = { since: sinceDate };
      console.log(`[${folderPath}] 首次同步，拉取最近 ${sinceDays} 天`);
    } else {
      // 增量: UID > lastUid
      // ImapFlow search 用 uid range
      searchCriteria = {};
    }

    let lock;
    try {
      lock = await client.getMailboxLock(folderPath);
    } catch (e) {
      console.log(`[${folderPath}] 无法打开，跳过: ${e.message.slice(0, 60)}`);
      continue;
    }

    try {
      let uids;
      if (lastUid === 0) {
        // 首次: 用 since 搜索
        const result = await client.search(searchCriteria, { uid: true });
        uids = Array.isArray(result) ? result : [];
      } else {
        // 增量: 搜索 UID > lastUid
        const result = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true });
        uids = Array.isArray(result) ? result.filter(u => u > lastUid) : [];
      }

      if (uids.length === 0) {
        console.log(`[${folderPath}] 无新邮件`);
        lock.release();
        continue;
      }

      console.log(`[${folderPath}] ${uids.length} 封新邮件待同步`);

      // 逐封处理
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(String(uid), {
            uid: true,
            envelope: true,
            bodyStructure: true,
            source: true
          }, { uid: true });

          if (!msg) continue;

          const env = msg.envelope || {};

          // 提取 body
          const textPartId = findPartByType(msg.bodyStructure, 'text/plain');
          const htmlPartId = findPartByType(msg.bodyStructure, 'text/html');

          let bodyText = null;
          let bodyHtml = null;

          if (textPartId) {
            const buf = await downloadPart(client, uid, textPartId);
            if (buf) bodyText = buf.toString('utf-8');
          }
          if (htmlPartId) {
            const buf = await downloadPart(client, uid, htmlPartId);
            if (buf) bodyHtml = buf.toString('utf-8');
          }

          // 正文：如果有 text/plain 直接用，否则从 HTML 转换
          const bodyClean = getTextBody(bodyText, bodyHtml);

          // 附件处理
          const attachments = extractAttachments(msg.bodyStructure);
          const hasAttachment = attachments.length > 0;

          // 下载附件到本地
          const attachDir = path.join(__dirname, 'data', 'attachments', folderPath, String(uid));
          if (hasAttachment) {
            fs.mkdirSync(attachDir, { recursive: true });
          }

          const SMALL_ATTACHMENT_LIMIT = 5 * 1024 * 1024; // 5MB
          const attachmentsMeta = [];
          const bigAttachmentQueue = []; // 大附件延后下载

          for (const att of attachments) {
            const localPath = path.join(attachDir, att.filename);

            if (att.size && att.size > SMALL_ATTACHMENT_LIMIT) {
              // 大附件：先记录元信息，不下载，后台处理
              attachmentsMeta.push({
                name: att.filename,
                type: att.mimeType,
                size: att.size,
                local_path: null,
                pending: true,
                _part: att.part,
                _uid: uid,
                _folder: folderPath,
                _localPath: localPath
              });
              bigAttachmentQueue.push({ uid, part: att.part, localPath, meta_index: attachmentsMeta.length - 1 });
            } else {
              // 小附件：立即下载
              try {
                const buf = await downloadPart(client, uid, att.part);
                if (buf) {
                  fs.writeFileSync(localPath, buf);
                  attachmentsMeta.push({
                    name: att.filename,
                    type: att.mimeType,
                    size: buf.length,
                    local_path: localPath
                  });
                }
              } catch (e) {
                attachmentsMeta.push({
                  name: att.filename,
                  type: att.mimeType,
                  size: att.size,
                  local_path: null,
                  error: e.message.slice(0, 60)
                });
              }
            }
          }

          // 解析地址
          const fromAddr = env.from?.[0]?.address || '';
          const fromName = env.from?.[0]?.name || '';
          const toAddrs = JSON.stringify((env.to || []).map(a => a.address));
          const ccAddrs = JSON.stringify((env.cc || []).map(a => a.address));

          // 解析 headers 获取 references
          let references = null;
          if (msg.source && Buffer.isBuffer(msg.source)) {
            const raw = msg.source.toString('utf-8');
            const headerEnd = raw.indexOf('\r\n\r\n');
            if (headerEnd >= 0) {
              const headerSection = raw.slice(0, headerEnd);
              const refMatch = headerSection.match(/^References:\s*(.+?)(?=\r\n\S|\r\n\r\n)/ms);
              if (refMatch) references = refMatch[1].replace(/\s+/g, ' ').trim();
            }
          }

          const messageId = env.messageId || null;
          const inReplyTo = env.inReplyTo || null;
          const threadId = computeThreadId(db, messageId, inReplyTo, references);

          const date = env.date ? new Date(env.date).toISOString() : new Date().toISOString();

          // body_raw: 原始提取的正文（text 优先，fallback html→text）
          const bodyRaw = getTextBody(bodyText, bodyHtml);

          const result = insertEmail.run(
            uid, folderPath, messageId, inReplyTo, threadId,
            fromAddr, fromName, toAddrs, ccAddrs,
            env.subject || '', date, bodyRaw,
            hasAttachment ? 1 : 0,
            JSON.stringify(attachmentsMeta)
          );

          // 回复体分割 → 写入 email_turns
          if (result.changes > 0) {
            const emailId = result.lastInsertRowid;
            const turns = splitReplyBody(bodyRaw, {
              from_name: fromName,
              from_addr: fromAddr,
              date: date
            });
            for (const turn of turns) {
              insertTurn.run(
                emailId, turn.turn_index,
                turn.from_name, turn.from_addr, turn.date,
                turn.content
              );
            }
          }

          totalSynced++;
          if (uid > lastUid) lastUid = uid;
        } catch (e) {
          console.error(`  [UID:${uid}] 同步失败: ${e.message.slice(0, 80)}`);
        }
      }

      upsertSyncState.run(folderPath, lastUid, lastUid);
      console.log(`[${folderPath}] 同步完成, last_uid=${lastUid}`);
    } finally {
      lock.release();
    }
  }

  // 4. 后台下载大附件（不阻塞主流程，主流程已结束邮件入库）
  const pendingAttachments = db.prepare(`
    SELECT id, uid, folder, attachments FROM emails
    WHERE attachments LIKE '%"pending":true%'
  `).all();

  if (pendingAttachments.length > 0) {
    console.log(`\n后台下载 ${pendingAttachments.length} 封邮件的大附件...`);

    // 重新连接 IMAP（之前的 lock 已释放）
    const dlClient = new ImapFlow({
      host: config.account.imap.host,
      port: config.account.imap.port,
      secure: config.account.imap.tls,
      auth: { user: config.account.email, pass: config.account.password },
      logger: false
    });
    await dlClient.connect();

    for (const email of pendingAttachments) {
      const atts = JSON.parse(email.attachments || '[]');
      let updated = false;

      for (const att of atts) {
        if (!att.pending) continue;
        try {
          const lock = await dlClient.getMailboxLock(email.folder);
          try {
            const buf = await downloadPart(dlClient, email.uid, att._part);
            if (buf) {
              const dir = path.dirname(att._localPath);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(att._localPath, buf);
              att.local_path = att._localPath;
              att.size = buf.length;
              delete att.pending;
              delete att._part;
              delete att._uid;
              delete att._folder;
              delete att._localPath;
              updated = true;
              console.log(`  ✓ [UID:${email.uid}] ${att.name} (${Math.round(buf.length / 1024 / 1024)}MB)`);
            }
          } finally {
            lock.release();
          }
        } catch (e) {
          console.log(`  ✗ [UID:${email.uid}] ${att.name}: ${e.message.slice(0, 60)}`);
          att.error = e.message.slice(0, 60);
          delete att.pending;
          updated = true;
        }
      }

      if (updated) {
        db.prepare('UPDATE emails SET attachments = ? WHERE id = ?').run(JSON.stringify(atts), email.id);
      }
    }

    await dlClient.logout();
  }

  // 5. 更新 contacts 聚合表
  console.log('更新联系人聚合...');
  db.exec(`
    INSERT OR REPLACE INTO contacts (addr, name, last_email_at, email_count, folders)
    SELECT
      from_addr,
      MAX(from_name),
      MAX(date),
      COUNT(*),
      json_group_array(DISTINCT folder)
    FROM emails
    WHERE from_addr != ''
    GROUP BY from_addr
  `);

  // 6. 清理过期附件
  const retentionDays = config.sync.attachment_retention_days || 30;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  const oldEmails = db.prepare(`
    SELECT id, attachments FROM emails
    WHERE has_attachment = 1 AND synced_at < ? AND attachments LIKE '%local_path%'
  `).all(cutoffDate.toISOString());

  let cleanedFiles = 0;
  for (const email of oldEmails) {
    try {
      const atts = JSON.parse(email.attachments);
      for (const att of atts) {
        if (att.local_path && fs.existsSync(att.local_path)) {
          fs.unlinkSync(att.local_path);
          att.local_path = null;
          cleanedFiles++;
        }
      }
      db.prepare('UPDATE emails SET attachments = ? WHERE id = ?').run(JSON.stringify(atts), email.id);
    } catch {}
  }
  if (cleanedFiles > 0) console.log(`清理过期附件: ${cleanedFiles} 个文件`);

  await client.logout();
  db.close();

  const elapsed = ((Date.now() - startTime.getTime()) / 1000).toFixed(1);
  console.log(`同步完成: ${totalSynced} 封新邮件, 耗时 ${elapsed}s`);
}

// 运行
sync().catch(e => {
  console.error('同步失败:', e.message);
  process.exit(1);
});
