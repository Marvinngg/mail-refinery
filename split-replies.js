/**
 * 回复体分割 — 把一封邮件的 body 拆分为独立的对话轮次
 *
 * 识别 Outlook 中文/英文/日文、Gmail、通用分隔线等引用格式
 * 输出: [{turn_index, from_name, from_addr, date, content}]
 */

// 引用头部模式 — 每种格式提取发件人和日期
const QUOTE_PATTERNS = [
  {
    // Outlook 中文: 发件人: X\n发送时间: Y
    name: 'outlook_cn',
    startRegex: /^发件人:\s*(.+)\r?\n发送时间:\s*(.+)/m,
    extractInfo: (match) => {
      const fromLine = match[1].trim();
      const dateLine = match[2].trim();
      const addrMatch = fromLine.match(/<([^>]+)>/);
      const nameMatch = fromLine.match(/^([^<]+)/);
      return {
        from_name: nameMatch ? nameMatch[1].trim() : '',
        from_addr: addrMatch ? addrMatch[1] : fromLine,
        date: dateLine
      };
    }
  },
  {
    // Outlook 英文: From: X\nSent: Y
    name: 'outlook_en',
    startRegex: /^From:\s*(.+)\r?\nSent:\s*(.+)/m,
    extractInfo: (match) => {
      const fromLine = match[1].trim();
      const dateLine = match[2].trim();
      const addrMatch = fromLine.match(/<([^>]+)>/);
      const nameMatch = fromLine.match(/^([^<]+)/);
      return {
        from_name: nameMatch ? nameMatch[1].trim() : '',
        from_addr: addrMatch ? addrMatch[1] : fromLine,
        date: dateLine
      };
    }
  },
  {
    // 日文 Outlook: 差出人: X
    name: 'outlook_jp',
    startRegex: /^差出人:\s*(.+)/m,
    extractInfo: (match) => {
      const fromLine = match[1].trim();
      const addrMatch = fromLine.match(/<([^>]+)>/);
      const nameMatch = fromLine.match(/^([^<]+)/);
      return {
        from_name: nameMatch ? nameMatch[1].trim() : '',
        from_addr: addrMatch ? addrMatch[1] : fromLine,
        date: ''
      };
    }
  }
];

// 分隔线模式（不含发件人信息，只表示引用开始）
const SEPARATOR_PATTERNS = [
  /^_{10,}\s*$/m,                          // Outlook ________
  /^-{5,}\s*Original Message\s*-{3,}/mi,   // -----Original Message-----
  /^-{5,}\s*Forwarded message\s*-{3,}/mi,  // ---------- Forwarded message ----------
  /^-{5,}\s*转发的邮件\s*-{3,}/mi,         // 转发分隔
];

/**
 * 分割一封邮件的 body 为对话轮次
 * @param {string} body - 邮件原始正文
 * @param {object} emailMeta - 这封邮件的元信息 {from_name, from_addr, date}
 * @returns {Array<{turn_index, from_name, from_addr, date, content}>}
 */
function splitReplyBody(body, emailMeta) {
  if (!body || body.trim() === '') {
    return [{
      turn_index: 0,
      from_name: emailMeta.from_name || '',
      from_addr: emailMeta.from_addr || '',
      date: emailMeta.date || '',
      content: ''
    }];
  }

  // 统一换行符
  let text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 找到所有引用头部的位置
  const splitPoints = [];

  for (const pattern of QUOTE_PATTERNS) {
    let remaining = text;
    let offset = 0;
    let match;

    while ((match = pattern.startRegex.exec(remaining)) !== null) {
      const info = pattern.extractInfo(match);
      splitPoints.push({
        index: offset + match.index,
        length: match[0].length,
        ...info,
        type: pattern.name
      });

      // 继续搜索剩余文本（跳过当前匹配后面的内容找下一个）
      const nextStart = match.index + match[0].length;

      // 跳过紧跟的 To:/Subject: 等行
      let skipEnd = nextStart;
      const lines = remaining.slice(nextStart).split('\n');
      for (const line of lines) {
        if (/^(To|Cc|Subject|收件人|抄送|主题):\s/i.test(line)) {
          skipEnd += line.length + 1;
        } else {
          break;
        }
      }

      offset += skipEnd;
      remaining = text.slice(offset);
    }
  }

  // 也检查分隔线
  for (const sepPattern of SEPARATOR_PATTERNS) {
    const match = sepPattern.exec(text);
    if (match) {
      splitPoints.push({
        index: match.index,
        length: match[0].length,
        from_name: '',
        from_addr: '',
        date: '',
        type: 'separator'
      });
    }
  }

  // 如果没有找到任何引用标记，整封作为一个 turn
  if (splitPoints.length === 0) {
    return [{
      turn_index: 0,
      from_name: emailMeta.from_name || '',
      from_addr: emailMeta.from_addr || '',
      date: emailMeta.date || '',
      content: cleanTurnContent(text)
    }];
  }

  // 按位置排序
  splitPoints.sort((a, b) => a.index - b.index);

  // 构建 turns
  const turns = [];

  // turn_index=0: 邮件作者的新内容（第一个引用标记之前的部分）
  const firstSplit = splitPoints[0];
  const authorContent = text.slice(0, firstSplit.index);
  turns.push({
    turn_index: 0,
    from_name: emailMeta.from_name || '',
    from_addr: emailMeta.from_addr || '',
    date: emailMeta.date || '',
    content: cleanTurnContent(authorContent)
  });

  // 后续 turns: 引用的历史内容
  for (let i = 0; i < splitPoints.length; i++) {
    const sp = splitPoints[i];

    // 这段引用的内容：从引用头部之后到下一个引用头部之前
    const contentStart = sp.index + sp.length;

    // 跳过紧跟的 header 行（To:/Subject:/收件人: 等）
    let actualStart = contentStart;
    const afterHeader = text.slice(contentStart);
    const headerLines = afterHeader.split('\n');
    for (const line of headerLines) {
      if (/^(To|Cc|Subject|收件人|抄送|主题):\s/i.test(line.trim()) || line.trim() === '') {
        actualStart += line.length + 1;
      } else {
        break;
      }
    }

    const contentEnd = i + 1 < splitPoints.length ? splitPoints[i + 1].index : text.length;
    const content = text.slice(actualStart, contentEnd);

    turns.push({
      turn_index: i + 1,
      from_name: sp.from_name,
      from_addr: sp.from_addr,
      date: sp.date,
      content: cleanTurnContent(content)
    });
  }

  return turns;
}

/**
 * 清理单轮内容：去掉签名、多余空行
 */
function cleanTurnContent(text) {
  if (!text) return '';

  let cleaned = text;

  // 去掉常见签名模式
  // 独立的 "--" 行之后是签名
  const sigIdx = cleaned.search(/^--\s*$/m);
  if (sigIdx > 0 && sigIdx < cleaned.length - 5) {
    cleaned = cleaned.slice(0, sigIdx);
  }

  // 规范化空行
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

module.exports = { splitReplyBody };

// 如果直接运行，做测试
if (require.main === module) {
  const Database = require('better-sqlite3');
  const path = require('path');
  const db = new Database(path.join(__dirname, 'data', 'mail.db'));

  // 测试几封有引用的邮件
  const testEmails = db.prepare(`
    SELECT uid, from_name, from_addr, date, subject, body_raw
    FROM emails
    WHERE body_raw LIKE '%From:%Sent:%' OR body_raw LIKE '%发件人:%发送时间:%'
    ORDER BY date DESC
    LIMIT 5
  `).all();

  console.log(`测试 ${testEmails.length} 封有引用的邮件\n`);

  for (const email of testEmails) {
    const turns = splitReplyBody(email.body_raw, {
      from_name: email.from_name,
      from_addr: email.from_addr,
      date: email.date
    });

    console.log(`[UID:${email.uid}] ${email.subject?.slice(0, 50)}`);
    console.log(`  拆分为 ${turns.length} 轮:`);
    for (const turn of turns) {
      const preview = turn.content.slice(0, 80).replace(/\n/g, ' ');
      console.log(`  [${turn.turn_index}] ${turn.from_name || '?'} (${turn.date?.slice(0, 10) || '?'}): ${preview}...`);
    }
    console.log();
  }

  db.close();
}
