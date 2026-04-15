/**
 * 附件内容提取 — 从下载的附件文件中提取可读文本
 */

const fs = require('fs');
const path = require('path');

function extractXlsx(filePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const results = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length === 0) continue;
    const header = data[0] || [];
    const rows = data.slice(1, 6); // 前5行数据
    results.push({
      sheet: name,
      columns: header.length,
      rows: data.length - 1,
      header: header.map(String).join(' | '),
      sample: rows.map(r => r.map(String).join(' | ')).join('\n')
    });
  }
  return results.map(s =>
    `Sheet "${s.sheet}": ${s.columns}列 × ${s.rows}行\n表头: ${s.header}\n前5行:\n${s.sample}`
  ).join('\n\n');
}

function extractDocx(filePath) {
  const mammoth = require('mammoth');
  // mammoth is async but we need sync - use execSync workaround
  const { execSync } = require('child_process');
  const script = `
    const mammoth = require('mammoth');
    mammoth.extractRawText({path: '${filePath.replace(/'/g, "\\'")}'})
      .then(r => process.stdout.write(r.value.slice(0, 3000)));
  `;
  try {
    const text = execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
      timeout: 10000, encoding: 'utf-8', cwd: __dirname
    });
    return text.trim();
  } catch {
    return null;
  }
}

function extractPdf(filePath) {
  // pdf-parse is async, use execSync
  const { execSync } = require('child_process');
  try {
    const text = execSync(
      `node -e "require('pdf-parse')(require('fs').readFileSync('${filePath.replace(/'/g, "\\'")}'))" +
       ".then(d => process.stdout.write(d.text.slice(0, 3000)))"`,
      { timeout: 15000, encoding: 'utf-8', cwd: __dirname }
    );
    return text.trim();
  } catch {
    return null;
  }
}

function extractZip(filePath) {
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    return `ZIP 包含 ${entries.length} 个文件:\n` +
      entries.map(e => `  ${e.entryName} (${Math.round(e.header.size / 1024)}KB)`).join('\n');
  } catch {
    return null;
  }
}

/**
 * 提取附件内容摘要
 * @param {string} filePath - 附件本地路径
 * @param {string} filename - 文件名
 * @returns {string|null} - 提取的文本内容，或 null
 */
function extractAttachmentContent(filePath, filename) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const ext = path.extname(filename).toLowerCase();
  try {
    switch (ext) {
      case '.xlsx': case '.xls': case '.csv':
        return extractXlsx(filePath);
      case '.docx':
        return extractDocx(filePath);
      case '.pdf':
        return extractPdf(filePath);
      case '.zip': case '.rar': case '.7z':
        return extractZip(filePath);
      case '.txt': case '.md': case '.json': case '.xml':
        return fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
      default:
        return null; // 图片等二进制文件跳过
    }
  } catch (e) {
    return `[提取失败: ${e.message.slice(0, 50)}]`;
  }
}

module.exports = { extractAttachmentContent };

// 直接运行时测试
if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'mail.db'));

  const emails = db.prepare(`
    SELECT uid, attachments FROM emails WHERE has_attachment = 1
  `).all();

  let extracted = 0, failed = 0, skipped = 0;
  for (const email of emails) {
    const atts = JSON.parse(email.attachments || '[]');
    for (const att of atts) {
      const content = extractAttachmentContent(att.local_path, att.name);
      if (content) {
        extracted++;
        console.log(`✓ [UID:${email.uid}] ${att.name}: ${content.length} chars`);
      } else if (att.local_path) {
        skipped++;
        console.log(`- [UID:${email.uid}] ${att.name}: 跳过 (${path.extname(att.name)})`);
      } else {
        failed++;
      }
    }
  }
  console.log(`\n提取: ${extracted}, 跳过: ${skipped}, 失败: ${failed}`);
  db.close();
}
