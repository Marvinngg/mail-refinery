/**
 * 附件内容提取 — 从下载的附件文件中提取可读文本
 *
 * 提取日志写入 data/attachment_extract.log
 */

const fs = require('fs');
const path = require('path');

// 文件大小上限（超过的跳过，不读取）
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// 不读取的格式（音视频、图片、大型二进制）
const SKIP_EXTENSIONS = new Set([
  '.wav', '.mp3', '.mp4', '.avi', '.mov', '.flv', '.wmv', '.aac', '.ogg',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.ico', '.webp', '.tiff',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso', '.dmg',
  '.psd', '.ai', '.sketch', '.fig',
]);

// 日志
const LOG_PATH = path.join(__dirname, 'data', 'attachment_extract.log');

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

function extractXlsx(filePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const results = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (data.length === 0) continue;
    const header = data[0] || [];
    const rows = data.slice(1, 6);
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
  const { execSync } = require('child_process');
  const escapedPath = filePath.replace(/'/g, "'\\''");
  try {
    const text = execSync(
      `node -e 'require("mammoth").extractRawText({path:"${escapedPath}"}).then(r=>process.stdout.write(r.value.slice(0,3000)))'`,
      { timeout: 10000, encoding: 'utf-8', cwd: __dirname }
    );
    return text.trim() || null;
  } catch {
    return null;
  }
}

function extractPdf(filePath) {
  const { execSync } = require('child_process');
  const escapedPath = filePath.replace(/'/g, "'\\''");
  try {
    const text = execSync(
      `node -e 'const p=require("pdf-parse");const f=require("fs").readFileSync("${escapedPath}");p(f).then(d=>process.stdout.write(d.text.slice(0,3000)))'`,
      { timeout: 15000, encoding: 'utf-8', cwd: __dirname }
    );
    return text.trim() || null;
  } catch {
    return null;
  }
}

function extractZip(filePath) {
  const AdmZip = require('adm-zip');
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const results = [`ZIP 包含 ${entries.length} 个文件:`];

    for (const entry of entries) {
      const name = entry.entryName;
      const size = entry.header.size;
      const ext = path.extname(name).toLowerCase();

      // 跳过目录
      if (entry.isDirectory) continue;

      // 跳过超大文件和不支持的格式
      if (size > MAX_FILE_SIZE || SKIP_EXTENSIONS.has(ext)) {
        results.push(`  ${name} (${Math.round(size / 1024)}KB) [跳过]`);
        continue;
      }

      // 尝试读取 ZIP 内文件的内容
      try {
        if (['.xlsx', '.xls'].includes(ext)) {
          const XLSX = require('xlsx');
          const buf = entry.getData();
          const wb = XLSX.read(buf);
          const ws = wb.Sheets[wb.SheetNames[0]];
          if (ws) {
            const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
            const header = (data[0] || []).map(String).join(' | ');
            results.push(`  ${name} (${Math.round(size / 1024)}KB): 表头: ${header}`);
          }
        } else if (['.txt', '.md', '.json', '.xml', '.csv'].includes(ext)) {
          const text = entry.getData().toString('utf-8').slice(0, 500);
          results.push(`  ${name} (${Math.round(size / 1024)}KB): ${text.slice(0, 200).replace(/\n/g, ' ')}`);
        } else if (ext === '.docx') {
          // ZIP 内的 docx 不递归提取，只标注
          results.push(`  ${name} (${Math.round(size / 1024)}KB): [Word文档]`);
        } else {
          results.push(`  ${name} (${Math.round(size / 1024)}KB)`);
        }
      } catch {
        results.push(`  ${name} (${Math.round(size / 1024)}KB) [读取失败]`);
      }
    }

    return results.join('\n');
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
  if (!filePath || !fs.existsSync(filePath)) {
    log(`SKIP ${filename}: 文件不存在 (${filePath || 'null'})`);
    return null;
  }

  const ext = path.extname(filename).toLowerCase();

  // 跳过不支持的格式
  if (SKIP_EXTENSIONS.has(ext)) {
    log(`SKIP ${filename}: 不支持的格式 (${ext})`);
    return null;
  }

  // 检查文件大小
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    log(`SKIP ${filename}: 文件过大 (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    return null;
  }

  try {
    let result = null;
    switch (ext) {
      case '.xlsx': case '.xls': case '.csv':
        result = extractXlsx(filePath);
        break;
      case '.docx':
        result = extractDocx(filePath);
        break;
      case '.pdf':
        result = extractPdf(filePath);
        break;
      case '.zip':
        result = extractZip(filePath);
        break;
      case '.rar': case '.7z':
        log(`SKIP ${filename}: 暂不支持 ${ext} 格式`);
        return null;
      case '.txt': case '.md': case '.json': case '.xml':
        result = fs.readFileSync(filePath, 'utf-8').slice(0, 3000);
        break;
      default:
        log(`SKIP ${filename}: 未知格式 (${ext})`);
        return null;
    }

    if (result) {
      log(`OK ${filename}: ${result.length} chars`);
    } else {
      log(`FAIL ${filename}: 提取返回空`);
    }
    return result;
  } catch (e) {
    log(`FAIL ${filename}: ${e.message.slice(0, 80)}`);
    return null;
  }
}

module.exports = { extractAttachmentContent };

// 直接运行时测试
if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'mail.db'));

  // 清空日志
  fs.writeFileSync(LOG_PATH, '', 'utf-8');

  const emails = db.prepare('SELECT uid, attachments FROM emails WHERE has_attachment = 1').all();

  let extracted = 0, failed = 0, skipped = 0;
  for (const email of emails) {
    const atts = JSON.parse(email.attachments || '[]');
    for (const att of atts) {
      const content = extractAttachmentContent(att.local_path, att.name);
      if (content) {
        extracted++;
        console.log(`✓ [UID:${email.uid}] ${att.name}: ${content.length} chars`);
      } else {
        skipped++;
      }
    }
  }
  console.log(`\n提取: ${extracted}, 跳过/失败: ${skipped}`);
  console.log(`日志: ${LOG_PATH}`);
  db.close();
}
