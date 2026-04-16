#!/usr/bin/env node

/**
 * 统一入口 — 自动判断首次/增量
 *
 * 判断逻辑：
 * 1. data/events/ 有内容 + state 有效 → 增量
 * 2. data/events/ 有内容 + state 缺失 → 从文件结构重建 state → 增量
 * 3. data/events/ 为空或不存在 → 全量
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const EVENTS_DIR = path.join(__dirname, 'data', 'events');
const STATE_PATH = path.join(EVENTS_DIR, '_process_state.json');

function log(msg) {
  console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`);
}

function run(cmd) {
  log(`执行: ${cmd}`);
  try {
    execSync(cmd, { cwd: __dirname, stdio: 'inherit', timeout: 1800000 });
    return true;
  } catch (e) {
    log(`失败: ${e.message.slice(0, 100)}`);
    return false;
  }
}

function hasEventsContent() {
  if (!fs.existsSync(EVENTS_DIR)) return false;
  // 检查是否有至少一个 event.md
  try {
    const { execSync: exec } = require('child_process');
    const count = exec(`find "${EVENTS_DIR}" -name "event.md" | wc -l`, { encoding: 'utf-8' }).trim();
    return parseInt(count) > 0;
  } catch {
    return false;
  }
}

function isStateValid() {
  if (!fs.existsSync(STATE_PATH)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    return !!(state.last_processed_ids && state.thread_event_mapping);
  } catch {
    return false;
  }
}

function rebuildState() {
  // 从数据库和文件结构重建 state
  log('从现有数据重建处理状态...');
  const Database = require('better-sqlite3');
  const DB_PATH = path.join(__dirname, 'data', 'mail.db');
  if (!fs.existsSync(DB_PATH)) return false;

  const db = new Database(DB_PATH);

  // 所有已有邮件 ID
  const allIds = db.prepare('SELECT id FROM emails').all().map(e => e.id);

  // 从数据库的 thread_id 和文件系统的目录结构反推 mapping
  const mapping = {};
  const folders = db.prepare('SELECT DISTINCT folder FROM emails').all();

  for (const { folder } of folders) {
    const folderDir = path.join(EVENTS_DIR, folder);
    if (!fs.existsSync(folderDir)) continue;

    for (const projectEntry of fs.readdirSync(folderDir, { withFileTypes: true })) {
      if (!projectEntry.isDirectory() || projectEntry.name.startsWith('_')) continue;
      const projectDir = path.join(folderDir, projectEntry.name);

      for (const topicEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!topicEntry.isDirectory() || topicEntry.name.startsWith('_')) continue;
        const eventPath = path.join(projectDir, topicEntry.name, 'event.md');
        if (!fs.existsSync(eventPath)) continue;

        // 这个话题对应哪些 thread？从数据库按 subject 模糊匹配
        // 简化：把该文件夹所有 thread 都标记为已处理（不完美但能工作）
        const threads = db.prepare('SELECT DISTINCT thread_id FROM emails WHERE folder = ?').all(folder);
        for (const t of threads) {
          if (!mapping[t.thread_id]) {
            mapping[t.thread_id] = { project: projectEntry.name, topic: topicEntry.name };
          }
        }
      }
    }
  }

  const state = {
    last_processed_ids: allIds,
    last_processed_at: new Date().toISOString(),
    thread_event_mapping: mapping
  };

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  db.close();

  log(`重建完成: ${allIds.length} 封邮件, ${Object.keys(mapping).length} 条 thread 映射`);
  return true;
}

function main() {
  log('========== 开始 ==========');

  // 同步
  if (!run('node sync.js')) {
    log('同步失败，退出');
    process.exit(1);
  }

  // 判断模式
  if (hasEventsContent()) {
    // 有已有结果
    if (!isStateValid()) {
      // state 缺失/损坏 → 重建
      rebuildState();
    }
    log('模式: 增量');
    if (!run('node process-incremental.js')) {
      log('增量处理失败');
    }
  } else {
    // 无已有结果 → 全量
    log('模式: 全量');
    if (!run('node process.js')) {
      log('全量处理失败');
    }
  }

  log('========== 完成 ==========');
}

main();
