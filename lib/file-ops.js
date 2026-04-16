/**
 * 文件系统操作 — event.md / _index.md 的生成和更新
 *
 * 全量和增量共用
 */

const fs = require('fs');
const path = require('path');
const { callModel } = require('./model');
const { buildEntriesText } = require('./email-content');

const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');

/**
 * 生成话题的 event.md
 */
async function generateEventMd(db, folder, projectName, topic) {
  const threadIdPlaceholders = topic.thread_ids.map(() => '?').join(',');
  const emails = db.prepare(`
    SELECT e.id, e.uid, e.from_name, e.from_addr, e.to_addrs, e.date, e.subject,
           e.folder, e.has_attachment, e.attachments, e.in_reply_to
    FROM emails e
    WHERE e.thread_id IN (${threadIdPlaceholders})
    ORDER BY e.date DESC
  `).all(...topic.thread_ids);

  if (emails.length === 0) return null;

  const entriesText = buildEntriesText(db, emails);

  const prompt = `你是邮件分析助手。以下是项目「${projectName}」中话题「${topic.name}」的所有邮件记录。
每封邮件只包含新增内容（已去除引用链）。附件已提取内容摘要。

请生成 markdown 格式的事件文档。时间线按倒序（最新在前）。
附件的关键内容要体现在时间线和附件清单中——不只是文件名，要说明附件讲了什么。
附件清单中的"本地路径"列必须从邮件记录中的路径信息原样保留。

文件夹: ${folder}
邮件数: ${emails.length}

邮件记录（倒序，最新在前）：
${entriesText}

直接输出 markdown（不要 \`\`\`markdown 包裹）：

# ${topic.name}

## 概要
（2-3句话概括来龙去脉和当前状态）

## 参与者
（列出参与者及其角色/公司）

## 时间线（最新在前）

### YYYY-MM-DD — 发件人 [收件/发件]
（核心内容，保留关键信息，去掉客套话）
（附件内容要写清楚）

## 附件清单
（表格形式：文件名 | 日期 | 发送人 | 内容说明 | 本地路径）`;

  return await callModel(prompt, { max_tokens: 8000 });
}

/**
 * 追加新内容到已有 event.md（增量用）
 */
async function appendToEventMd(db, folder, projectName, topicName, newEmails) {
  const eventPath = path.join(EVENTS_DIR, folder, projectName, topicName, 'event.md');
  if (!fs.existsSync(eventPath)) return false;

  const existingMd = fs.readFileSync(eventPath, 'utf-8');

  // 提取现有概要（给模型上下文）
  const summaryMatch = existingMd.match(/## 概要\s*\n([\s\S]*?)(?=\n## )/);
  const existingSummary = summaryMatch ? summaryMatch[1].trim() : '';

  const entriesText = buildEntriesText(db, newEmails);

  const prompt = `你是邮件分析助手。以下是项目「${projectName}」中话题「${topicName}」的新邮件。

该话题已有的概要：
${existingSummary}

新增邮件（按时间倒序）：
${entriesText}

请生成：
1. 更新后的概要（基于已有概要 + 新邮件，2-3句话）
2. 新邮件的时间线条目（格式同已有文档）

返回 JSON：
{"updated_summary": "更新后的概要", "new_entries": "### YYYY-MM-DD — 发件人 [收件/发件]\\n内容..."}`;

  const response = await callModel(prompt, { max_tokens: 4000 });
  const result = require('./model').parseJSON(response);

  // 更新概要
  let updatedMd = existingMd;
  if (result.updated_summary && summaryMatch) {
    updatedMd = updatedMd.replace(summaryMatch[1], result.updated_summary);
  }

  // 在时间线最前面插入新条目
  if (result.new_entries) {
    const timelineIdx = updatedMd.indexOf('## 时间线');
    if (timelineIdx >= 0) {
      const firstEntryIdx = updatedMd.indexOf('\n### ', timelineIdx);
      if (firstEntryIdx >= 0) {
        updatedMd = updatedMd.slice(0, firstEntryIdx) + '\n' + result.new_entries + updatedMd.slice(firstEntryIdx);
      }
    }
  }

  fs.writeFileSync(eventPath, updatedMd, 'utf-8');
  return true;
}

/**
 * 生成项目级 _index.md（代码生成，不用模型）
 */
function generateProjectIndex(db, folder, projectName, topics) {
  const lines = [`# ${projectName}\n`, `> 项目下属于「${folder}」文件夹\n`, `## 话题列表\n`];

  for (const topic of topics) {
    const threadIdPlaceholders = topic.thread_ids.map(() => '?').join(',');
    const stats = db.prepare(`
      SELECT COUNT(*) as cnt, MIN(date) as first, MAX(date) as last,
             GROUP_CONCAT(DISTINCT from_name) as people
      FROM emails WHERE thread_id IN (${threadIdPlaceholders})
    `).get(...topic.thread_ids);

    const eventPath = path.join(EVENTS_DIR, folder, projectName, topic.name, 'event.md');
    let summary = topic.description || '';
    if (fs.existsSync(eventPath)) {
      const content = fs.readFileSync(eventPath, 'utf-8');
      const m = content.match(/## 概要\s*\n([\s\S]*?)(?=\n## )/);
      if (m) summary = m[1].trim();
    }

    lines.push(`### [${topic.name}](./${topic.name}/event.md)`);
    lines.push(`- 参与者: ${stats.people}`);
    lines.push(`- 时间: ${stats.first?.slice(0, 10)} ~ ${stats.last?.slice(0, 10)}`);
    lines.push(`- 概要: ${summary}\n`);
  }

  return lines.join('\n');
}

/**
 * 生成文件夹级 _index.md（代码生成，不用模型）
 */
function generateFolderIndex(db, folder, projects) {
  const folderLabel = folder === 'INBOX' ? '收件箱' : folder === '已发送' ? '已发送' : folder;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const lines = [`# ${folderLabel} — 概览\n`, `> 最后更新: ${now}\n`];

  const projectStats = projects.map(p => {
    const allThreadIds = p.topics.flatMap(t => t.thread_ids);
    const placeholders = allThreadIds.map(() => '?').join(',');
    const stats = allThreadIds.length > 0 ? db.prepare(`
      SELECT COUNT(*) as cnt, MAX(date) as last
      FROM emails WHERE thread_id IN (${placeholders})
    `).get(...allThreadIds) : { cnt: 0, last: '' };
    return { ...p, email_count: stats.cnt, last_date: stats.last };
  });
  projectStats.sort((a, b) => (b.last_date || '').localeCompare(a.last_date || ''));

  lines.push(`## 项目列表\n`);
  for (const p of projectStats) {
    lines.push(`### [${p.project}](./${p.project}/_index.md)`);
    lines.push(`- 话题数: ${p.topics.length}`);
    lines.push(`- 邮件数: ${p.email_count}`);
    lines.push(`- 话题: ${p.topics.map(t => t.name).join('、')}\n`);
  }

  return lines.join('\n');
}

/**
 * 写入文件（自动创建目录）
 */
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

module.exports = {
  EVENTS_DIR,
  generateEventMd,
  appendToEventMd,
  generateProjectIndex,
  generateFolderIndex,
  writeFile,
};
