#!/usr/bin/env node

/**
 * 邮件数据处理 — Phase 2
 *
 * 处理流程：
 * 1. 按文件夹独立处理
 * 2. 识别项目（高层分组）→ 项目内识别话题
 * 3. 每个话题生成 event.md（含附件内容摘要）
 * 4. 每个项目生成 _index.md
 * 5. 每个文件夹生成 _index.md
 * 6. 跨文件夹关联检查
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');
const { extractAttachmentContent } = require('./extract-attachments');

const DB_PATH = path.join(__dirname, 'data', 'mail.db');
const EVENTS_DIR = path.join(__dirname, 'data', 'events');

// ---------------------------------------------------------------------------
// 过滤规则：广告、垃圾邮件、无价值通知
// ---------------------------------------------------------------------------

const FILTER_RULES = {
  // 发件人模式匹配（小写）
  sender_patterns: [
    /noreply@.*apple/i,
    /insideapple\.apple\.com/i,
    /applemusic@/i,
    /news@.*apple/i,
    /no-?reply@/i,
  ],
  // 主题模式匹配
  subject_patterns: [
    /^<广告>/i,
    /unsubscribe/i,
    /退订/i,
  ],
  // 判断是否应该过滤
  shouldFilter(email) {
    const from = (email.from_addr || '').toLowerCase();
    const subject = email.subject || '';
    for (const p of this.sender_patterns) {
      if (p.test(from)) return true;
    }
    for (const p of this.subject_patterns) {
      if (p.test(subject)) return true;
    }
    return false;
  }
};

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

async function callModel(prompt, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600000);

  const response = await fetch(`${config.model.base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.model.api_key || 'none'}`
    },
    body: JSON.stringify({
      model: config.model.model_name,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 8000
    }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.choices[0].message.content || '';
}

function parseJSON(text) {
  const codeMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (codeMatch) return JSON.parse(codeMatch[1].trim());
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) return JSON.parse(arrMatch[0]);
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return JSON.parse(objMatch[0]);
  throw new Error(`No JSON found: ${text.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// 步骤 1: 项目识别 + 项目内话题识别（两层）
// ---------------------------------------------------------------------------

async function identifyProjectsAndTopics(db, folder) {
  const threads = db.prepare(`
    SELECT
      thread_id,
      COUNT(*) as email_count,
      GROUP_CONCAT(DISTINCT from_name) as participants,
      MIN(date) as first_date,
      MAX(date) as last_date,
      MAX(subject) as subject
    FROM emails
    WHERE folder = ? AND thread_id IS NOT NULL
    GROUP BY thread_id
    ORDER BY last_date DESC
  `).all(folder);

  if (threads.length === 0) return [];

  // 过滤：排除广告、垃圾邮件
  const filteredThreads = [];
  const filteredOut = [];
  for (const t of threads) {
    // 检查线程中的邮件是否应过滤
    const emails = db.prepare(`SELECT from_addr, subject FROM emails WHERE thread_id = ?`).all(t.thread_id);
    const shouldFilter = emails.every(e => FILTER_RULES.shouldFilter(e));
    if (shouldFilter) {
      filteredOut.push(t.subject?.slice(0, 40));
    } else {
      filteredThreads.push(t);
    }
  }
  if (filteredOut.length > 0) {
    console.log(`  过滤掉 ${filteredOut.length} 条无价值线程: ${filteredOut.join(', ')}`);
  }
  const threads_to_process = filteredThreads;

  // 给每个线程加上最新一封邮件的 turn_index=0 前 200 字作为内容提示
  for (const t of threads_to_process) {
    const latestEmail = db.prepare(`
      SELECT e.id FROM emails e
      WHERE e.thread_id = ? ORDER BY e.date DESC LIMIT 1
    `).get(t.thread_id);
    if (latestEmail) {
      const turn0 = db.prepare(`
        SELECT content FROM email_turns
        WHERE email_id = ? AND turn_index = 0
      `).get(latestEmail.id);
      t.content_hint = (turn0?.content || '').slice(0, 200);
    }
  }

  // 分批处理
  const BATCH_SIZE = 12;
  const allProjects = [];

  for (let batchStart = 0; batchStart < threads_to_process.length; batchStart += BATCH_SIZE) {
    const batch = threads_to_process.slice(batchStart, batchStart + BATCH_SIZE);

    const threadList = batch.map((t, i) =>
      `${i + 1}. subject="${t.subject?.slice(0, 80)}"\n   participants=[${t.participants}] emails=${t.email_count} dates=${t.first_date?.slice(0, 10)}~${t.last_date?.slice(0, 10)}\n   content_hint: ${t.content_hint?.slice(0, 150) || '(空)'}`
    ).join('\n\n');

    const prompt = `你是邮件分析助手。以下是邮件文件夹「${folder}」中的一批邮件线程。

请做两层分组：
第一层：识别这些线程属于哪些"项目"（一个大的业务/主题）
第二层：每个项目内，识别具体的"话题"（项目中的一个具体事项）

例如：一个客户项目下面可能有话题"内部定例会"、"系统测试"、"培训资料"等。
分类原则：
- 业务项目：与某个客户、产品或业务相关的邮件，按项目归组
- 内部系统：公司内部使用的IT系统（如OA、ERP、业务流转系统等）的通知或讨论
- 个人通知：个人账户、账单、安全提醒等
- 行政通知：放假、考勤、规章制度等
不同性质的邮件不要混在同一个项目里。

线程列表：
${threadList}

返回严格JSON：
[
  {
    "project": "项目名称",
    "topics": [
      {"name": "话题名称", "thread_indices": [1, 2], "description": "一句话描述"}
    ]
  }
]

规则：
- 项目名和话题名用中文，不含特殊字符（斜杠、冒号等）
- 每个线程只归入一个话题
- 所有线程都必须归入`;

    console.log(`  批次 ${Math.floor(batchStart / BATCH_SIZE) + 1}: ${batch.length} 条线程...`);
    const response = await callModel(prompt);
    const batchProjects = parseJSON(response);

    // 映射 thread_indices 回 thread_id
    for (const project of batchProjects) {
      // 查找已有同名项目合并
      let existing = allProjects.find(p => p.project === project.project);
      if (!existing) {
        existing = { project: project.project, topics: [] };
        allProjects.push(existing);
      }
      for (const topic of project.topics) {
        existing.topics.push({
          name: topic.name,
          description: topic.description,
          thread_ids: topic.thread_indices.map(i => batch[i - 1]?.thread_id).filter(Boolean)
        });
      }
    }
  }

  // 合并步骤：分批处理可能产生同一项目的不同命名，让模型合并
  if (allProjects.length > 3) {
    const projectList = allProjects.map((p, i) =>
      `${i + 1}. 项目「${p.project}」话题: ${p.topics.map(t => t.name).join('、')}`
    ).join('\n');

    const mergePrompt = `以下是从邮件中识别出的项目列表。有些项目可能实际上是同一个项目的不同方面（如"大成温调"和"大成AI系统"其实是同一个项目）。

${projectList}

请判断哪些项目应该合并，返回合并方案。格式：
[{"merged_name":"合并后的项目名","original_indices":[1,2,3]}]

如果某个项目不需要合并，也要列出（original_indices只有自己）。所有项目都必须出现。`;

    console.log(`  项目合并检查 (${allProjects.length} 个项目)...`);
    try {
      const mergeResponse = await callModel(mergePrompt);
      const mergeResult = parseJSON(mergeResponse);

      const mergedProjects = [];
      for (const merge of mergeResult) {
        const combined = { project: merge.merged_name, topics: [] };
        for (const idx of merge.original_indices) {
          const orig = allProjects[idx - 1];
          if (orig) combined.topics.push(...orig.topics);
        }
        if (combined.topics.length > 0) mergedProjects.push(combined);
      }

      if (mergedProjects.length > 0) {
        // 话题去重：同一项目内相同名称的话题合并 thread_ids
        for (const p of mergedProjects) {
          const topicMap = new Map();
          for (const t of p.topics) {
            const existing = topicMap.get(t.name);
            if (existing) {
              existing.thread_ids.push(...t.thread_ids);
              if (t.description.length > existing.description.length) {
                existing.description = t.description;
              }
            } else {
              topicMap.set(t.name, { ...t });
            }
          }
          p.topics = [...topicMap.values()];
        }
        console.log(`  合并: ${allProjects.length} → ${mergedProjects.length} 个项目`);
        return mergedProjects;
      }
    } catch (e) {
      console.log(`  合并失败，使用原始分组: ${e.message.slice(0, 60)}`);
    }
  }

  return allProjects;
}

// ---------------------------------------------------------------------------
// 步骤 2: 生成 event.md（含附件内容）
// ---------------------------------------------------------------------------

async function generateEventMd(db, folder, projectName, topic) {
  const threadIdPlaceholders = topic.thread_ids.map(() => '?').join(',');
  const emails = db.prepare(`
    SELECT e.id, e.uid, e.from_name, e.from_addr, e.to_addrs, e.date, e.subject,
           e.folder, e.has_attachment, e.attachments
    FROM emails e
    WHERE e.thread_id IN (${threadIdPlaceholders})
    ORDER BY e.date DESC
  `).all(...topic.thread_ids);

  if (emails.length === 0) return null;

  // 收集每封邮件的 turn_index=0 + 附件内容
  const entries = [];
  for (const email of emails) {
    const turn0 = db.prepare(`
      SELECT content FROM email_turns WHERE email_id = ? AND turn_index = 0
    `).get(email.id);

    const direction = email.folder === '已发送' ? '[发件]' : '[收件]';

    // 提取附件内容
    let attachInfo = '';
    if (email.has_attachment) {
      const atts = JSON.parse(email.attachments || '[]');
      const attDetails = [];
      for (const att of atts) {
        const content = extractAttachmentContent(att.local_path, att.name);
        if (content) {
          attDetails.push(`📎 ${att.name} (${Math.round((att.size || 0) / 1024)}KB)\n内容摘要: ${content.slice(0, 500)}`);
        } else {
          attDetails.push(`📎 ${att.name} (${Math.round((att.size || 0) / 1024)}KB) [${att.local_path ? '需手动查看: ' + att.local_path : '无法提取'}]`);
        }
      }
      attachInfo = '\n' + attDetails.join('\n');
    }

    entries.push(
      `[${email.date?.slice(0, 10)}] ${email.from_name || email.from_addr} ${direction}:\n${turn0?.content || '(无正文)'}${attachInfo}`
    );
  }

  const prompt = `你是邮件分析助手。以下是项目「${projectName}」中话题「${topic.name}」的所有邮件记录。
每封邮件只包含新增内容（已去除引用链）。附件已提取内容摘要。

请生成 markdown 格式的事件文档。时间线按倒序（最新在前）。
附件的关键内容要体现在时间线和附件清单中——不只是文件名，要说明附件讲了什么。
附件清单中的"本地路径"列必须从邮件记录中的路径信息原样保留，不要写 N/A。

文件夹: ${folder}
邮件数: ${emails.length}

邮件记录（倒序）：
${entries.join('\n\n---\n\n')}

直接输出 markdown（不要 \`\`\`markdown 包裹）：

# ${topic.name}

## 概要
（2-3句话概括来龙去脉和当前状态）

## 参与者
（列出参与者及其角色/公司）

## 时间线（最新在前）

### YYYY-MM-DD — 发件人 [收件/发件]
（核心内容，保留关键信息，去掉客套话）
（附件内容要写清楚：这个附件包含什么关键数据/信息）

## 附件清单
（表格形式：文件名 | 日期 | 发送人 | 内容说明 | 本地路径）`;

  const md = await callModel(prompt, { max_tokens: 8000 });
  return md;
}

// ---------------------------------------------------------------------------
// 步骤 3: 生成索引文件
// ---------------------------------------------------------------------------

function generateProjectIndex(db, folder, projectName, topics) {
  const lines = [`# ${projectName}\n`, `> 项目下属于「${folder}」文件夹\n`, `## 话题列表\n`];

  for (const topic of topics) {
    const threadIdPlaceholders = topic.thread_ids.map(() => '?').join(',');
    const stats = db.prepare(`
      SELECT COUNT(*) as cnt, MIN(date) as first, MAX(date) as last,
             GROUP_CONCAT(DISTINCT from_name) as people
      FROM emails WHERE thread_id IN (${threadIdPlaceholders})
    `).get(...topic.thread_ids);

    // 读 event.md 的概要
    const eventPath = path.join(EVENTS_DIR, folder, projectName, topic.name, 'event.md');
    let summary = topic.description;
    if (fs.existsSync(eventPath)) {
      const content = fs.readFileSync(eventPath, 'utf-8');
      const m = content.match(/## 概要\s*\n([\s\S]*?)(?=\n## )/);
      if (m) summary = m[1].trim();
    }

    lines.push(`### [${topic.name}](./${topic.name}/event.md)`);
    lines.push(`- 参与者: ${stats.people}`);
    lines.push(`- 时间: ${stats.first?.slice(0, 10)} ~ ${stats.last?.slice(0, 10)}`);
    lines.push(`- 邮件数: ${stats.cnt}`);
    lines.push(`- 概要: ${summary}\n`);
  }

  return lines.join('\n');
}

function generateFolderIndex(db, folder, projects) {
  const folderLabel = folder === 'INBOX' ? '收件箱' : folder === '已发送' ? '已发送' : folder;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const lines = [`# ${folderLabel} — 概览\n`, `> 最后更新: ${now}\n`];

  // 按最新活动倒序
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

// ---------------------------------------------------------------------------
// 步骤 4: 跨文件夹关联检查
// ---------------------------------------------------------------------------

async function crossFolderCheck(allFolderProjects) {
  if (Object.keys(allFolderProjects).length < 2) return null;

  const summary = Object.entries(allFolderProjects).map(([folder, projects]) =>
    `文件夹「${folder}」:\n` + projects.map(p =>
      `  项目: ${p.project} — 话题: ${p.topics.map(t => t.name).join('、')}`
    ).join('\n')
  ).join('\n\n');

  const prompt = `以下是不同邮件文件夹中识别出的项目和话题。请判断是否有跨文件夹的关联（比如收件箱的某个项目和已发送的某个项目是同一件事）。

${summary}

如果有关联，返回 JSON：
[{"folder1":"INBOX","project1":"项目A","folder2":"已发送","project2":"项目B","relation":"说明关联"}]
如果没有关联，返回空数组 []`;

  const response = await callModel(prompt);
  try {
    return parseJSON(response);
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

    // 步骤 1: 项目+话题识别
    console.log('\n[步骤1] 项目与话题识别');
    const projects = await identifyProjectsAndTopics(db, folder);
    allFolderProjects[folder] = projects;

    console.log(`  识别出 ${projects.length} 个项目:`);
    for (const p of projects) {
      console.log(`  📁 ${p.project}`);
      for (const t of p.topics) {
        console.log(`     └─ ${t.name} (${t.thread_ids.length}条线程)`);
      }
    }

    // 步骤 2: 生成 event.md
    console.log('\n[步骤2] 事件文档生成（含附件内容）');
    for (const project of projects) {
      for (const topic of project.topics) {
        const topicDir = path.join(EVENTS_DIR, folder, project.project, topic.name);
        fs.mkdirSync(topicDir, { recursive: true });

        const md = await generateEventMd(db, folder, project.project, topic);
        if (md) {
          fs.writeFileSync(path.join(topicDir, 'event.md'), md, 'utf-8');
          console.log(`    ✓ ${project.project}/${topic.name}/event.md`);
        }
      }
    }

    // 步骤 3: 生成索引
    console.log('\n[步骤3] 索引生成');
    for (const project of projects) {
      const projectDir = path.join(EVENTS_DIR, folder, project.project);
      fs.mkdirSync(projectDir, { recursive: true });
      const indexMd = generateProjectIndex(db, folder, project.project, project.topics);
      fs.writeFileSync(path.join(projectDir, '_index.md'), indexMd, 'utf-8');
      console.log(`    ✓ ${project.project}/_index.md`);
    }

    const folderIndexMd = generateFolderIndex(db, folder, projects);
    fs.writeFileSync(path.join(EVENTS_DIR, folder, '_index.md'), folderIndexMd, 'utf-8');
    console.log(`    ✓ ${folder}/_index.md`);
  }

  // 步骤 4: 跨文件夹关联
  console.log('\n[步骤4] 跨文件夹关联检查');
  const associations = await crossFolderCheck(allFolderProjects);
  if (associations && associations.length > 0) {
    console.log('  发现关联:');
    associations.forEach(a => console.log(`    ${a.folder1}/${a.project1} ↔ ${a.folder2}/${a.project2}: ${a.relation}`));
    // 写入根级关联文件
    const assocMd = `# 跨文件夹关联\n\n` +
      associations.map(a => `- **${a.folder1}/${a.project1}** ↔ **${a.folder2}/${a.project2}**: ${a.relation}`).join('\n');
    fs.writeFileSync(path.join(EVENTS_DIR, '_associations.md'), assocMd, 'utf-8');
  } else {
    console.log('  无跨文件夹关联');
  }

  // 保存处理状态（供增量模式使用）
  const threadEventMapping = {};
  for (const [folder, projects] of Object.entries(allFolderProjects)) {
    for (const p of projects) {
      for (const t of p.topics) {
        for (const tid of t.thread_ids) {
          threadEventMapping[tid] = { project: p.project, topic: t.name };
        }
      }
    }
  }

  const allEmailIds = db.prepare('SELECT id FROM emails').all().map(e => e.id);
  const stateFile = path.join(EVENTS_DIR, '_process_state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    last_processed_ids: allEmailIds,
    last_processed_at: new Date().toISOString(),
    thread_event_mapping: threadEventMapping
  }, null, 2));

  db.close();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n全部完成，耗时 ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

async function dryRun() {
  const db = new Database(DB_PATH);
  const folders = db.prepare('SELECT DISTINCT folder FROM emails ORDER BY folder').all();

  for (const { folder } of folders) {
    console.log(`\n===== ${folder} =====`);
    const projects = await identifyProjectsAndTopics(db, folder);
    for (const p of projects) {
      console.log(`\n📁 ${p.project}`);
      for (const t of p.topics) {
        console.log(`   └─ ${t.name}: ${t.description}`);
        console.log(`      线程: ${t.thread_ids.length}条`);
      }
    }
  }

  db.close();
}

// ---------------------------------------------------------------------------
// 增量模式：处理新邮件，追加到已有事件结构
// ---------------------------------------------------------------------------

async function incremental() {
  const db = new Database(DB_PATH);
  const startTime = Date.now();

  // 读取上次处理的状态
  const stateFile = path.join(EVENTS_DIR, '_process_state.json');
  let processState = { last_processed_ids: [] };
  if (fs.existsSync(stateFile)) {
    processState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  }

  const lastIds = new Set(processState.last_processed_ids);

  // 找到未处理的邮件
  const allEmails = db.prepare('SELECT id, uid, folder, thread_id, from_addr, subject FROM emails ORDER BY id').all();
  const newEmails = allEmails.filter(e => !lastIds.has(e.id));

  if (newEmails.length === 0) {
    console.log('无新邮件需要处理');
    db.close();
    return;
  }

  console.log(`${newEmails.length} 封新邮件待处理`);

  // 按文件夹分组
  const byFolder = {};
  for (const e of newEmails) {
    if (FILTER_RULES.shouldFilter(e)) continue;
    if (!byFolder[e.folder]) byFolder[e.folder] = [];
    byFolder[e.folder].push(e);
  }

  for (const [folder, emails] of Object.entries(byFolder)) {
    console.log(`\n处理 ${folder}: ${emails.length} 封新邮件`);

    for (const email of emails) {
      // 检查这封邮件的 thread_id 是否已有对应的事件文件夹
      const existingEvent = findExistingEvent(folder, email.thread_id);

      if (existingEvent) {
        // 追加到已有事件
        console.log(`  [UID:${email.uid}] 追加到 ${existingEvent.project}/${existingEvent.topic}`);
        await appendToEvent(db, folder, existingEvent, email);
      } else {
        // 新线程：让模型判断归属
        console.log(`  [UID:${email.uid}] 新线程，模型判断归属...`);
        await classifyNewThread(db, folder, email);
      }
    }
  }

  // 更新处理状态
  processState.last_processed_ids = allEmails.map(e => e.id);
  processState.last_processed_at = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(processState, null, 2));

  db.close();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n增量处理完成，耗时 ${elapsed}s`);
}

// 查找已有事件文件夹中是否包含某个 thread_id
function findExistingEvent(folder, threadId) {
  const folderDir = path.join(EVENTS_DIR, folder);
  if (!fs.existsSync(folderDir)) return null;

  // 遍历项目/话题目录，查找 event.md 中是否引用了这个 thread
  // 简化：通过 _process_state.json 里存的 thread→event 映射
  const stateFile = path.join(EVENTS_DIR, '_process_state.json');
  if (!fs.existsSync(stateFile)) return null;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  const mapping = state.thread_event_mapping || {};
  return mapping[threadId] || null;
}

// 追加新邮件到已有事件
async function appendToEvent(db, folder, eventInfo, email) {
  const eventPath = path.join(EVENTS_DIR, folder, eventInfo.project, eventInfo.topic, 'event.md');
  if (!fs.existsSync(eventPath)) return;

  // 获取新邮件的 turn_index=0
  const turn0 = db.prepare(`
    SELECT content FROM email_turns
    WHERE email_id = (SELECT id FROM emails WHERE uid = ? AND folder = ?) AND turn_index = 0
  `).get(email.uid, folder);

  const direction = email.folder === '已发送' ? '[发件]' : '[收件]';
  const date = db.prepare('SELECT date FROM emails WHERE uid = ? AND folder = ?').get(email.uid, folder)?.date?.slice(0, 10);

  // 读现有 event.md，在"## 时间线"后插入新条目
  let content = fs.readFileSync(eventPath, 'utf-8');
  const timelineIdx = content.indexOf('## 时间线');
  if (timelineIdx >= 0) {
    const insertPoint = content.indexOf('\n### ', timelineIdx);
    if (insertPoint >= 0) {
      const newEntry = `\n### ${date} — ${email.from_addr?.split('@')[0] || '?'} ${direction}\n${turn0?.content || '(新邮件)'}\n`;
      content = content.slice(0, insertPoint) + newEntry + content.slice(insertPoint);
      fs.writeFileSync(eventPath, content, 'utf-8');
    }
  }
}

// 新线程分类
async function classifyNewThread(db, folder, email) {
  // 获取现有项目列表
  const folderDir = path.join(EVENTS_DIR, folder);
  if (!fs.existsSync(folderDir)) {
    console.log(`    文件夹 ${folder} 无已有项目，跳过（等待全量处理）`);
    return;
  }

  const projects = fs.readdirSync(folderDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '_index.md')
    .map(d => {
      const indexPath = path.join(folderDir, d.name, '_index.md');
      return { name: d.name, exists: fs.existsSync(indexPath) };
    })
    .filter(p => p.exists)
    .map(p => p.name);

  if (projects.length === 0) return;

  const prompt = `现有项目列表: ${projects.join('、')}

新邮件信息:
- 发件人: ${email.from_addr}
- 主题: ${email.subject}

这封邮件属于哪个项目？如果不属于任何现有项目，回答"新项目:项目名"。
只回答项目名称，不要解释。`;

  const response = await callModel(prompt, { max_tokens: 500 });
  console.log(`    归属判断: ${response.trim().slice(0, 50)}`);
}

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--dry-run')) {
  dryRun().catch(e => { console.error('Error:', e.message); process.exit(1); });
} else if (args.includes('--incremental')) {
  incremental().catch(e => { console.error('Error:', e.message); process.exit(1); });
} else {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
