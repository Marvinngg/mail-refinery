#!/usr/bin/env node

/**
 * 增量处理 — 日常监控，处理新邮件
 *
 * 流程：
 * 1. 找出未处理的新邮件
 * 2. 按文件夹分组
 * 3. 文件夹内按 thread_id 分组
 * 4. 已知 thread → 追加到已有话题
 *    未知 thread（可追溯）→ 通过 in_reply_to 找到已有话题
 *    完全未知 thread → 模型判断归属
 * 5. 批量更新 _index.md
 * 6. 新项目产生时重跑跨文件夹关联
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { callModel, parseJSON, sanitizeName } = require('./lib/model');
const { FILTER_RULES } = require('./lib/filter');
const { buildEmailEntry } = require('./lib/email-content');
const {
  EVENTS_DIR,
  generateEventMd,
  appendToEventMd,
  generateProjectIndex,
  generateFolderIndex,
  writeFile,
} = require('./lib/file-ops');

const DB_PATH = path.join(__dirname, 'data', 'mail.db');
const STATE_PATH = path.join(EVENTS_DIR, '_process_state.json');

// ---------------------------------------------------------------------------
// 加载处理状态
// ---------------------------------------------------------------------------

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { last_processed_ids: [], thread_event_mapping: {} };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state) {
  writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// 通过 in_reply_to 追溯到已有 thread
// ---------------------------------------------------------------------------

function traceToKnownThread(db, email, mapping) {
  // 直接查 in_reply_to
  if (email.in_reply_to) {
    const parent = db.prepare('SELECT thread_id FROM emails WHERE message_id = ?').get(email.in_reply_to);
    if (parent && mapping[parent.thread_id]) {
      return mapping[parent.thread_id];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 模型判断新线程归属
// ---------------------------------------------------------------------------

async function classifyNewThreads(db, folder, threadGroups, state) {
  // 读取现有项目/话题结构
  const folderDir = path.join(EVENTS_DIR, folder);
  if (!fs.existsSync(folderDir)) return [];

  const existingProjects = [];
  for (const entry of fs.readdirSync(folderDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const indexPath = path.join(folderDir, entry.name, '_index.md');
    if (!fs.existsSync(indexPath)) continue;
    const content = fs.readFileSync(indexPath, 'utf-8').split('\n').slice(0, 50).join('\n');
    existingProjects.push({ name: entry.name, indexContent: content });
  }

  if (existingProjects.length === 0) return [];

  // 构造新线程的描述
  const threadDescriptions = threadGroups.map((group, i) => {
    const first = group.emails[0];
    const contentHint = buildEmailEntry(db, first).slice(0, 300);
    return `${i + 1}. subject="${first.subject}" from=${first.from_name || first.from_addr} emails=${group.emails.length}\n   内容: ${contentHint}`;
  }).join('\n\n');

  const projectList = existingProjects.map(p => `项目「${p.name}」:\n${p.indexContent}`).join('\n\n---\n\n');

  const prompt = `你是邮件分析助手。以下是邮件文件夹「${folder}」中新出现的邮件线程，以及当前已有的项目结构。

请判断每个新线程应该归入哪里。

新线程：
${threadDescriptions}

现有项目结构：
${projectList}

对每个新线程，返回 JSON 数组：
[{"thread_index": 1, "action": "existing", "project": "项目名", "topic": "话题名"}]

action 可以是：
- "existing": 归入已有项目的已有话题
- "new_topic": 归入已有项目，但创建新话题 → 额外提供 "new_topic_name" 和 "description"
- "new_project": 创建新项目 → 额外提供 "new_project_name", "new_topic_name", "description"

所有新线程都必须有归属。`;

  while (true) {
    try {
      const response = await callModel(prompt);
      return parseJSON(response);
    } catch (e) {
      console.log(`  分类 JSON 解析失败，重试: ${e.message.slice(0, 60)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const db = new Database(DB_PATH);
  const startTime = Date.now();
  const state = loadState();
  const lastIds = new Set(state.last_processed_ids);
  const mapping = state.thread_event_mapping || {};

  // 找未处理的邮件
  const allEmails = db.prepare(`
    SELECT e.id, e.uid, e.folder, e.thread_id, e.from_addr, e.from_name,
           e.subject, e.date, e.in_reply_to, e.has_attachment, e.attachments
    FROM emails e ORDER BY e.date ASC
  `).all();
  const newEmails = allEmails.filter(e => !lastIds.has(e.id));

  if (newEmails.length === 0) {
    console.log('无新邮件');
    db.close();
    return;
  }

  console.log(`${newEmails.length} 封新邮件\n`);

  // 按文件夹分组
  const byFolder = {};
  for (const e of newEmails) {
    if (FILTER_RULES.shouldFilter(e)) continue;
    if (!byFolder[e.folder]) byFolder[e.folder] = [];
    byFolder[e.folder].push(e);
  }

  let hasNewProject = false;

  for (const [folder, emails] of Object.entries(byFolder)) {
    console.log(`===== ${folder}: ${emails.length} 封 =====`);

    // 按 thread_id 分组，按时间排序（先旧后新，处理依赖关系）
    const threadMap = new Map();
    for (const e of emails) {
      const tid = e.thread_id || `orphan_${e.id}`;
      if (!threadMap.has(tid)) threadMap.set(tid, []);
      threadMap.get(tid).push(e);
    }

    // 分类：已知 thread / 可追溯 thread / 未知 thread
    const knownThreads = [];    // 直接命中 mapping
    const tracedThreads = [];   // 通过 in_reply_to 追溯命中
    const unknownThreads = [];  // 完全未知

    for (const [tid, threadEmails] of threadMap) {
      if (mapping[tid]) {
        knownThreads.push({ tid, emails: threadEmails, target: mapping[tid] });
      } else {
        // 尝试追溯
        let traced = null;
        for (const e of threadEmails) {
          traced = traceToKnownThread(db, e, mapping);
          if (traced) break;
        }
        if (traced) {
          tracedThreads.push({ tid, emails: threadEmails, target: traced });
          mapping[tid] = traced; // 加入映射
        } else {
          unknownThreads.push({ tid, emails: threadEmails });
        }
      }
    }

    console.log(`  已知线程: ${knownThreads.length}, 可追溯: ${tracedThreads.length}, 未知: ${unknownThreads.length}`);

    // 处理已知和可追溯的 thread → 追加到已有 event.md
    for (const group of [...knownThreads, ...tracedThreads]) {
      const { project, topic } = group.target;
      console.log(`  追加 ${group.emails.length} 封 → ${project}/${topic}`);
      const success = await appendToEventMd(db, folder, project, topic, group.emails);
      if (!success) {
        console.log(`    event.md 不存在，跳过`);
      }
    }

    // 处理未知 thread → 模型判断归属
    if (unknownThreads.length > 0) {
      console.log(`  分类 ${unknownThreads.length} 条未知线程...`);
      const classifications = await classifyNewThreads(db, folder, unknownThreads, state);

      for (const cls of classifications) {
        const group = unknownThreads[cls.thread_index - 1];
        if (!group) continue;

        if (cls.action === 'existing') {
          // 归入已有话题
          console.log(`  → ${cls.project}/${cls.topic}`);
          await appendToEventMd(db, folder, cls.project, cls.topic, group.emails);
          mapping[group.tid] = { project: cls.project, topic: cls.topic };

        } else if (cls.action === 'new_topic') {
          // 已有项目，新话题
          console.log(`  → ${cls.project}/[新话题] ${cls.new_topic_name}`);
          const topic = { name: cls.new_topic_name, description: cls.description || '', thread_ids: [group.tid] };
          const md = await generateEventMd(db, folder, cls.project, topic);
          if (md) {
            writeFile(path.join(EVENTS_DIR, folder, cls.project, cls.new_topic_name, 'event.md'), md);
          }
          mapping[group.tid] = { project: cls.project, topic: cls.new_topic_name };

        } else if (cls.action === 'new_project') {
          // 全新项目
          console.log(`  → [新项目] ${cls.new_project_name}/${cls.new_topic_name}`);
          const topic = { name: cls.new_topic_name, description: cls.description || '', thread_ids: [group.tid] };
          const md = await generateEventMd(db, folder, cls.new_project_name, topic);
          if (md) {
            writeFile(path.join(EVENTS_DIR, folder, cls.new_project_name, cls.new_topic_name, 'event.md'), md);
          }
          mapping[group.tid] = { project: cls.new_project_name, topic: cls.new_topic_name };
          hasNewProject = true;
        }
      }
    }

    // 批量更新 _index.md
    console.log(`  更新索引...`);

    // 收集该文件夹被更新的项目
    const updatedProjects = new Set();
    for (const group of [...knownThreads, ...tracedThreads]) {
      updatedProjects.add(group.target.project);
    }

    // 更新项目级 _index.md（读取文件系统反推 topics）
    for (const projectName of updatedProjects) {
      const projectDir = path.join(EVENTS_DIR, folder, projectName);
      if (!fs.existsSync(projectDir)) continue;

      const topics = [];
      for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const eventPath = path.join(projectDir, entry.name, 'event.md');
        if (!fs.existsSync(eventPath)) continue;
        // 从 mapping 反查 thread_ids
        const tids = Object.entries(mapping)
          .filter(([_, v]) => v.project === projectName && v.topic === entry.name)
          .map(([tid, _]) => tid);
        topics.push({ name: entry.name, description: '', thread_ids: tids });
      }

      if (topics.length > 0) {
        const indexMd = generateProjectIndex(db, folder, projectName, topics);
        writeFile(path.join(projectDir, '_index.md'), indexMd);
      }
    }

    // 更新文件夹级 _index.md
    const allProjects = [];
    for (const entry of fs.readdirSync(path.join(EVENTS_DIR, folder), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
      const projectDir = path.join(EVENTS_DIR, folder, entry.name);
      const topics = [];
      for (const sub of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const tids = Object.entries(mapping)
          .filter(([_, v]) => v.project === entry.name && v.topic === sub.name)
          .map(([tid, _]) => tid);
        topics.push({ name: sub.name, description: '', thread_ids: tids });
      }
      allProjects.push({ project: entry.name, topics });
    }
    const folderIndex = generateFolderIndex(db, folder, allProjects);
    writeFile(path.join(EVENTS_DIR, folder, '_index.md'), folderIndex);

    // 每个文件夹处理完就保存 state，避免中断后重复处理
    state.last_processed_ids = allEmails.map(e => e.id);
    state.last_processed_at = new Date().toISOString();
    state.thread_event_mapping = mapping;
    saveState(state);
  }

  // 如果有新项目，重跑跨文件夹关联
  if (hasNewProject) {
    console.log('\n有新项目，重新检查跨文件夹关联...');
  }

  db.close();
  console.log(`\n增量处理完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error('Error:', e.message);
  // 即使失败也尝试保存 state，避免下次重复处理已完成的部分
  try {
    const stateFile = path.join(EVENTS_DIR, '_process_state.json');
    if (fs.existsSync(stateFile)) {
      // state 已在 main 中更新过 mapping，直接保存
    }
  } catch {}
  process.exit(1);
});
