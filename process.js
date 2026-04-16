#!/usr/bin/env node

/**
 * 全量处理 — 首次初始化或重新整理
 *
 * 流程：
 * 1. 按文件夹独立 → 分批识别项目+话题
 * 2. 生成 event.md（含附件内容）
 * 3. 生成项目级 _index.md
 * 4. 项目合并判断（基于已生成的 _index.md 内容）
 * 5. 生成文件夹级 _index.md
 * 6. 跨文件夹关联检查
 * 7. 保存处理状态
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { callModel, parseJSON, sanitizeName } = require('./lib/model');
const { FILTER_RULES } = require('./lib/filter');
const {
  EVENTS_DIR,
  generateEventMd,
  generateProjectIndex,
  generateFolderIndex,
  writeFile,
} = require('./lib/file-ops');

const DB_PATH = path.join(__dirname, 'data', 'mail.db');

// ---------------------------------------------------------------------------
// 步骤 1: 项目+话题识别（分批）
// ---------------------------------------------------------------------------

async function identifyProjectsAndTopics(db, folder) {
  const threads = db.prepare(`
    SELECT thread_id, COUNT(*) as email_count,
      GROUP_CONCAT(DISTINCT from_name) as participants,
      MIN(date) as first_date, MAX(date) as last_date,
      MAX(subject) as subject
    FROM emails WHERE folder = ? AND thread_id IS NOT NULL
    GROUP BY thread_id ORDER BY last_date DESC
  `).all(folder);

  if (threads.length === 0) return [];

  // 过滤
  const filtered = [];
  const filteredOut = [];
  for (const t of threads) {
    const emails = db.prepare('SELECT from_addr, subject FROM emails WHERE thread_id = ?').all(t.thread_id);
    if (emails.every(e => FILTER_RULES.shouldFilter(e))) {
      filteredOut.push(t.subject?.slice(0, 40));
    } else {
      filtered.push(t);
    }
  }
  if (filteredOut.length > 0) console.log(`  过滤 ${filteredOut.length} 条: ${filteredOut.join(', ')}`);

  // 内容提示
  for (const t of filtered) {
    const latest = db.prepare('SELECT e.id FROM emails e WHERE e.thread_id = ? ORDER BY e.date DESC LIMIT 1').get(t.thread_id);
    if (latest) {
      const turn0 = db.prepare('SELECT content FROM email_turns WHERE email_id = ? AND turn_index = 0').get(latest.id);
      t.content_hint = (turn0?.content || '').slice(0, 200);
    }
  }

  // 分批
  const BATCH_SIZE = 12;
  const allProjects = [];

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    const batch = filtered.slice(i, i + BATCH_SIZE);
    const threadList = batch.map((t, j) =>
      `${j + 1}. subject="${t.subject?.slice(0, 80)}"\n   participants=[${t.participants}] emails=${t.email_count} dates=${t.first_date?.slice(0, 10)}~${t.last_date?.slice(0, 10)}\n   content_hint: ${t.content_hint?.slice(0, 150) || '(空)'}`
    ).join('\n\n');

    const prompt = `你是邮件分析助手。以下是邮件文件夹「${folder}」中的一批邮件线程。

请做两层分组：
第一层：识别这些线程属于哪些"项目"（一个大的业务/主题）
第二层：每个项目内，识别具体的"话题"（项目中的一个具体事项）

分类原则：
- 业务项目：与某个客户、产品或业务相关的邮件，按项目归组
- 内部系统：公司内部使用的IT系统的通知或讨论
- 个人通知：个人账户、账单、安全提醒等
- 行政通知：放假、考勤、规章制度等
不同性质的邮件不要混在同一个项目里。

线程列表：
${threadList}

返回严格JSON：
[{"project":"项目名称","topics":[{"name":"话题名称","thread_indices":[1,2],"description":"一句话描述"}]}]

规则：项目名和话题名用中文，不含特殊字符。每个线程只归入一个话题。所有线程都必须归入。`;

    console.log(`  批次 ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} 条线程...`);
    const response = await callModel(prompt);
    const batchProjects = parseJSON(response);

    for (const project of batchProjects) {
      const projectName = sanitizeName(project.project);
      let existing = allProjects.find(p => p.project === projectName);
      if (!existing) {
        existing = { project: projectName, topics: [] };
        allProjects.push(existing);
      }
      for (const topic of project.topics) {
        existing.topics.push({
          name: sanitizeName(topic.name),
          description: topic.description,
          thread_ids: topic.thread_indices.map(j => batch[j - 1]?.thread_id).filter(Boolean)
        });
      }
    }
  }

  return allProjects;
}

// ---------------------------------------------------------------------------
// 步骤 4: 项目合并（基于已生成的 _index.md）
// ---------------------------------------------------------------------------

async function mergeProjects(db, folder, projects) {
  if (projects.length <= 3) return projects;

  const projectSummaries = projects.map((p, i) => {
    const indexPath = path.join(EVENTS_DIR, folder, p.project, '_index.md');
    let content = '';
    if (fs.existsSync(indexPath)) {
      content = fs.readFileSync(indexPath, 'utf-8').split('\n').slice(0, 100).join('\n');
    }
    return `${i + 1}. 项目「${p.project}」\n${content}`;
  }).join('\n\n---\n\n');

  const prompt = `以下是同一个邮件文件夹中识别出的多个项目及其内容索引。请判断是否有项目应该合并：

1. 同一业务不同命名的项目合并为一个（判断依据：参与者重叠、话题相关、时间重叠）
2. 非业务类的零散项目合并为一个"通知与杂项"

原则：最终项目数量要精简。

${projectSummaries}

返回合并方案（JSON数组）：
[{"merged_name":"合并后名称","original_indices":[1,2,3]}]

所有项目都必须出现在某个合并组中。`;

  console.log(`  项目合并判断 (${projects.length} 个)...`);
  try {
    const response = await callModel(prompt);
    const mergeResult = parseJSON(response);

    const merged = [];
    for (const m of mergeResult) {
      const combined = { project: m.merged_name, topics: [] };
      for (const idx of m.original_indices) {
        const orig = projects[idx - 1];
        if (orig) combined.topics.push(...orig.topics);
      }
      if (combined.topics.length > 0) merged.push(combined);
    }

    if (merged.length > 0 && merged.length < projects.length) {
      // 话题去重
      for (const p of merged) {
        const map = new Map();
        for (const t of p.topics) {
          const existing = map.get(t.name);
          if (existing) { existing.thread_ids.push(...t.thread_ids); }
          else { map.set(t.name, { ...t }); }
        }
        p.topics = [...map.values()];
      }

      // 文件系统重组
      for (const mp of merged) {
        const mergedDir = path.join(EVENTS_DIR, folder, mp.project);
        fs.mkdirSync(mergedDir, { recursive: true });
        for (const topic of mp.topics) {
          const targetDir = path.join(mergedDir, topic.name);
          if (fs.existsSync(targetDir)) continue;
          for (const origP of projects) {
            const srcEvent = path.join(EVENTS_DIR, folder, origP.project, topic.name, 'event.md');
            if (fs.existsSync(srcEvent)) {
              fs.mkdirSync(targetDir, { recursive: true });
              fs.copyFileSync(srcEvent, path.join(targetDir, 'event.md'));
              break;
            }
          }
        }
        const indexMd = generateProjectIndex(db, folder, mp.project, mp.topics);
        writeFile(path.join(mergedDir, '_index.md'), indexMd);
      }

      // 删除旧目录
      for (const origP of projects) {
        if (!merged.some(mp => mp.project === origP.project)) {
          const oldDir = path.join(EVENTS_DIR, folder, origP.project);
          if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });
        }
      }

      console.log(`  合并: ${projects.length} → ${merged.length}`);
      return merged;
    }
  } catch (e) {
    console.log(`  合并失败: ${e.message.slice(0, 60)}`);
  }

  return projects;
}

// ---------------------------------------------------------------------------
// 步骤 6: 跨文件夹关联
// ---------------------------------------------------------------------------

async function crossFolderCheck(allFolderProjects) {
  if (Object.keys(allFolderProjects).length < 2) return [];

  const summary = Object.entries(allFolderProjects).map(([folder, projects]) =>
    `文件夹「${folder}」:\n` + projects.map(p =>
      `  项目: ${p.project} — 话题: ${p.topics.map(t => t.name).join('、')}`
    ).join('\n')
  ).join('\n\n');

  const prompt = `以下是不同邮件文件夹中识别出的项目和话题。请判断是否有跨文件夹的关联。

${summary}

有关联返回 JSON，无关联返回 []`;

  try {
    return parseJSON(await callModel(prompt));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const db = new Database(DB_PATH);
  const startTime = Date.now();
  fs.mkdirSync(EVENTS_DIR, { recursive: true });

  const folders = db.prepare('SELECT DISTINCT folder FROM emails ORDER BY folder').all();
  const allFolderProjects = {};

  for (const { folder } of folders) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`处理文件夹: ${folder}`);
    console.log('='.repeat(50));

    // 步骤 1
    console.log('\n[步骤1] 项目与话题识别');
    let projects = await identifyProjectsAndTopics(db, folder);
    console.log(`  ${projects.length} 个项目`);
    projects.forEach(p => {
      console.log(`  📁 ${p.project}`);
      p.topics.forEach(t => console.log(`     └─ ${t.name} (${t.thread_ids.length}条线程)`));
    });

    // 步骤 2
    console.log('\n[步骤2] 事件文档生成');
    for (const project of projects) {
      for (const topic of project.topics) {
        const md = await generateEventMd(db, folder, project.project, topic);
        if (md) {
          const topicDir = path.join(EVENTS_DIR, folder, project.project, topic.name);
          writeFile(path.join(topicDir, 'event.md'), md);
          console.log(`    ✓ ${project.project}/${topic.name}`);
        }
      }
    }

    // 步骤 3
    console.log('\n[步骤3] 项目索引');
    for (const project of projects) {
      const indexMd = generateProjectIndex(db, folder, project.project, project.topics);
      writeFile(path.join(EVENTS_DIR, folder, project.project, '_index.md'), indexMd);
    }

    // 步骤 4
    console.log('\n[步骤4] 项目合并');
    projects = await mergeProjects(db, folder, projects);
    allFolderProjects[folder] = projects;

    // 步骤 5
    console.log('\n[步骤5] 文件夹索引');
    const folderIndex = generateFolderIndex(db, folder, projects);
    writeFile(path.join(EVENTS_DIR, folder, '_index.md'), folderIndex);
  }

  // 步骤 6
  console.log('\n[步骤6] 跨文件夹关联');
  const assoc = await crossFolderCheck(allFolderProjects);
  if (assoc.length > 0) {
    const md = `# 跨文件夹关联\n\n` + assoc.map(a =>
      `- **${a.folder1}/${a.project1}** ↔ **${a.folder2}/${a.project2}**: ${a.relation}`
    ).join('\n');
    writeFile(path.join(EVENTS_DIR, '_associations.md'), md);
  }

  // 步骤 7: 保存状态
  const threadMapping = {};
  for (const [folder, projects] of Object.entries(allFolderProjects)) {
    for (const p of projects) {
      for (const t of p.topics) {
        for (const tid of t.thread_ids) {
          threadMapping[tid] = { project: p.project, topic: t.name };
        }
      }
    }
  }
  const allIds = db.prepare('SELECT id FROM emails').all().map(e => e.id);
  writeFile(path.join(EVENTS_DIR, '_process_state.json'), JSON.stringify({
    last_processed_ids: allIds,
    last_processed_at: new Date().toISOString(),
    thread_event_mapping: threadMapping
  }, null, 2));

  db.close();
  console.log(`\n全部完成，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
