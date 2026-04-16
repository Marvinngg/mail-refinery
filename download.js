#!/usr/bin/env node

/**
 * 附件下载 — 独立脚本，不阻塞 sync 和 process
 *
 * 读数据库中未下载的附件，逐个从 IMAP 下载到本地
 * 支持断点续传（已下载的跳过）
 * 单个附件超时 5 分钟自动跳过
 */

const { ImapFlow } = require('imapflow');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');

const DB_PATH = path.join(__dirname, 'data', 'mail.db');

async function downloadPart(client, uid, partId, timeoutMs = 300000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('下载超时')), timeoutMs);
    try {
      const dl = await client.download(String(uid), partId, { uid: true });
      if (!dl?.content) { clearTimeout(timer); resolve(null); return; }
      const chunks = [];
      for await (const chunk of dl.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function main() {
  const db = new Database(DB_PATH);

  // 找所有未下载的附件
  const emails = db.prepare(`
    SELECT id, uid, folder, attachments FROM emails
    WHERE has_attachment = 1 AND attachments LIKE '%"local_path":null%'
  `).all();

  let needDownload = 0;
  for (const email of emails) {
    const atts = JSON.parse(email.attachments || '[]');
    needDownload += atts.filter(a => !a.local_path && a.part).length;
  }

  if (needDownload === 0) {
    console.log('所有附件已下载');
    db.close();
    return;
  }

  console.log(`${needDownload} 个附件待下载\n`);

  const client = new ImapFlow({
    host: config.account.imap.host,
    port: config.account.imap.port,
    secure: config.account.imap.tls,
    auth: { user: config.account.email, pass: config.account.password },
    logger: false
  });
  await client.connect();

  let downloaded = 0, failed = 0;

  for (const email of emails) {
    const atts = JSON.parse(email.attachments || '[]');
    let updated = false;

    for (const att of atts) {
      if (att.local_path || !att.part) continue;

      const targetPath = att._target_path || path.join(__dirname, 'data', 'attachments', email.folder, String(email.uid), att.name);

      // 已存在则跳过
      if (fs.existsSync(targetPath)) {
        att.local_path = targetPath;
        updated = true;
        continue;
      }

      try {
        const lock = await client.getMailboxLock(email.folder);
        try {
          const buf = await downloadPart(client, email.uid, att.part);
          if (buf) {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, buf);
            att.local_path = targetPath;
            att.size = buf.length;
            downloaded++;
            console.log(`✓ [UID:${email.uid}] ${att.name} (${Math.round(buf.length / 1024)}KB)`);
          }
        } finally {
          lock.release();
        }
      } catch (e) {
        failed++;
        console.log(`✗ [UID:${email.uid}] ${att.name}: ${e.message.slice(0, 60)}`);
      }
      updated = true;
    }

    if (updated) {
      db.prepare('UPDATE emails SET attachments = ? WHERE id = ?').run(JSON.stringify(atts), email.id);
    }
  }

  await client.logout();
  db.close();
  console.log(`\n完成: ${downloaded} 下载, ${failed} 失败`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
