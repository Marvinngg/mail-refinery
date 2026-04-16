/**
 * 邮件内容构造 — 全量和增量共用
 *
 * 负责：turn 选择、回复体兜底、附件内容提取、拼接成模型输入
 */

const { extractAttachmentContent } = require('../extract-attachments');

/**
 * 构造一封邮件的模型输入内容
 * @param {object} db - SQLite 数据库连接
 * @param {object} email - emails 表的一行
 * @returns {string} - 拼接好的文本
 */
function buildEmailEntry(db, email) {
  const direction = email.folder === '已发送' ? '[发件]' : '[收件]';

  // 判断是否需要所有 turn
  const isForward = /^(Fw:|Fwd:|转发[:：])/i.test(email.subject || '');
  const parentExists = email.in_reply_to
    ? !!db.prepare('SELECT 1 FROM emails WHERE message_id = ?').get(email.in_reply_to)
    : false;
  const isChainHead = !parentExists;
  const needAllTurns = isForward || isChainHead;

  // 取内容
  let emailContent = '';
  if (needAllTurns) {
    const allTurns = db.prepare(`
      SELECT turn_index, from_name, date, content FROM email_turns
      WHERE email_id = ? ORDER BY turn_index ASC
    `).all(email.id);

    if (allTurns.length > 1) {
      emailContent = allTurns.map(t =>
        t.turn_index === 0
          ? t.content
          : `[引用 ${t.from_name || '?'} ${t.date?.slice(0, 10) || ''}] ${t.content}`
      ).join('\n\n');
    } else {
      emailContent = allTurns[0]?.content || '(无正文)';
    }
  } else {
    const turn0 = db.prepare(`
      SELECT content FROM email_turns WHERE email_id = ? AND turn_index = 0
    `).get(email.id);
    emailContent = turn0?.content || '(无正文)';
  }

  // 分割质量兜底
  const rawBody = db.prepare('SELECT body_raw FROM emails WHERE id = ?').get(email.id)?.body_raw || '';
  const hasQuoteMarkers = /^(From:|发件人:|差出人:|On .+ wrote:)/m.test(rawBody);
  const turnCount = db.prepare('SELECT COUNT(*) as c FROM email_turns WHERE email_id = ?').get(email.id)?.c || 0;
  if (turnCount <= 1 && hasQuoteMarkers && rawBody.length > 500) {
    emailContent = `[注意：以下正文包含未拆分的引用/转发内容，请识别其中的对话结构]\n${rawBody.slice(0, 3000)}`;
  }

  // 附件内容
  let attachInfo = '';
  if (email.has_attachment) {
    const atts = JSON.parse(email.attachments || '[]');
    const attDetails = [];
    for (const att of atts) {
      const content = extractAttachmentContent(att.local_path, att.name);
      if (content) {
        attDetails.push(`📎 ${att.name} (${Math.round((att.size || 0) / 1024)}KB) [${att.local_path || ''}]\n内容摘要: ${content.slice(0, 500)}`);
      } else {
        attDetails.push(`📎 ${att.name} (${Math.round((att.size || 0) / 1024)}KB) [${att.local_path ? '查看: ' + att.local_path : '无法提取'}]`);
      }
    }
    attachInfo = '\n' + attDetails.join('\n');
  }

  return `[${email.date?.slice(0, 10)}] ${email.from_name || email.from_addr} ${direction}:\n${emailContent}${attachInfo}`;
}

/**
 * 为一组邮件构造模型输入，带长度控制
 * @param {object} db
 * @param {Array} emails - 按时间倒序排列的邮件列表
 * @param {number} maxChars - 最大总字符数
 * @returns {string} - 拼接好的文本
 */
function buildEntriesText(db, emails, maxChars = 20000) {
  const entries = emails.map(e => buildEmailEntry(db, e));

  let totalChars = 0;
  const trimmed = [];
  for (const entry of entries) {
    if (totalChars + entry.length > maxChars) {
      trimmed.push(`[... 更早的 ${entries.length - trimmed.length} 封邮件省略，共 ${entries.length} 封]`);
      break;
    }
    trimmed.push(entry);
    totalChars += entry.length;
  }

  return trimmed.join('\n\n---\n\n');
}

module.exports = { buildEmailEntry, buildEntriesText };
