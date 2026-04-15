# mail-refinery

企业邮件 AI 精炼管线 — 将杂乱的企业邮箱数据精炼为按项目/话题组织的结构化 Markdown 知识库。

## 一、问题与目标

企业邮箱中的邮件数据天然是杂乱的：

- **正文嵌套**：一封回复邮件包含所有历史回复全文，11 万字里真正新增的可能只有 200 字
- **关系隐含**：邮件之间的关联藏在 Message-ID/In-Reply-To/References header 里
- **分组扁平**：一个文件夹里可能有多个项目、多条业务线同时进行
- **收发分散**：同一件事的来回邮件分布在收件箱和已发送

**目标**：把原始邮件数据精炼为按 `文件夹 → 项目 → 话题` 三层组织的 Markdown 文件，每个话题有完整的事件脉络（谁在什么时间说了什么、附了什么文件），供 AI Agent 直接读取消费。

## 二、系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│                     数据获取层 (sync.js)                          │
│                                                                  │
│  IMAP 按文件夹增量拉取                                            │
│    ↓                                                             │
│  正文提取 (findPartByType 遍历 bodyStructure)                     │
│    ↓                                                             │
│  回复体分割 (识别引用格式，拆分为独立对话轮次)                       │
│    ↓                                                             │
│  技术线程分组 (Message-ID / In-Reply-To 链)                       │
│    ↓                                                             │
│  附件下载 + 内容提取 (xlsx/docx/pdf/zip)                          │
│    ↓                                                             │
│  写入 SQLite (emails + email_turns 表)                           │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                    数据处理层 (process.js)                         │
│                                                                  │
│  过滤 (广告/垃圾邮件规则匹配)                                      │
│    ↓                                                             │
│  项目识别 (本地模型：线程元信息+内容提示 → 两层分组)                  │
│    ↓                                                             │
│  项目合并 (跨批次同名项目去重)                                      │
│    ↓                                                             │
│  事件脉络生成 (本地模型：turn_index=0 + 附件内容 → event.md)        │
│    ↓                                                             │
│  索引生成 (项目级 _index.md + 文件夹级 _index.md)                  │
│    ↓                                                             │
│  跨文件夹关联检查                                                  │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│                     产出：Markdown 知识库                          │
│                                                                  │
│  data/events/                                                    │
│  ├── INBOX/                                                      │
│  │   ├── _index.md                    (文件夹级概览)               │
│  │   ├── 项目A/                                                   │
│  │   │   ├── _index.md                (项目级概览)                 │
│  │   │   ├── 话题1/event.md           (事件脉络)                   │
│  │   │   └── 话题2/event.md                                       │
│  │   ├── 项目B/                                                   │
│  │   │   └── ...                                                 │
│  │   └── ...                                                     │
│  ├── 已发送/                                                      │
│  │   └── ...                                                     │
│  └── _process_state.json              (处理状态，增量用)            │
└──────────────────────────────────────────────────────────────────┘
```

## 三、数据获取层 — 完整工作流

### 3.1 IMAP 按文件夹增量拉取

**文件**：`sync.js`

**机制**：
1. `IMAP LIST` 获取邮箱所有文件夹列表
2. 按配置跳过无需同步的文件夹（如草稿箱、已删除）
3. 对每个需同步的文件夹：
   - 从 `sync_state` 表读取该文件夹的 `last_uid`
   - 首次同步（last_uid=0）：`IMAP SEARCH SINCE <N天前>`
   - 增量同步：`IMAP SEARCH UID <last_uid+1>:*`，过滤掉 UID <= last_uid 的结果
4. 逐封 `FETCH envelope + bodyStructure + source`
5. 更新 `sync_state` 表

**263 邮箱特殊说明**：
- STATUS 命令返回的邮件数与 SELECT 后实际可见的邮件数不一致（STATUS 包含已归档邮件，SELECT 不包含）
- 以 SELECT 后的 SEARCH 结果为准

### 3.2 正文提取（multipart body 处理）

**问题**：邮件正文在 IMAP 中以 MIME multipart 结构存储。一封回复邮件的结构可能是：

```
multipart/mixed (根节点)
├── multipart/alternative
│   ├── text/plain (part 1.1)    ← 纯文本正文
│   └── text/html (part 1.2)     ← HTML 正文
└── application/pdf (part 2)      ← 附件
```

直接 `download(uid, '1')` 下载的是 `multipart/alternative` 容器的 raw MIME 数据，不是正文。

**解决方案**：`findPartByType` 函数递归遍历 bodyStructure 树，找到 `text/plain` 和 `text/html` 的确切 part 编号（如 `1.1`），然后精确下载。

```javascript
function findPartByType(node, targetType) {
  if (!node) return undefined;
  // ImapFlow 的 type 字段是完整 MIME 类型，如 "text/plain"
  if (node.type === targetType && node.disposition !== 'attachment') {
    return node.part || '1';
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const found = findPartByType(child, targetType);
      if (found) return found;
    }
  }
  return undefined;
}
```

**验证**：在 263 邮箱上测试了 2 层嵌套（part 1.1）、3 层嵌套（part 1.1.1）、7 层回复链（111,582 字），全部正确提取，无 MIME boundary 泄漏。

### 3.3 回复体分割

**文件**：`split-replies.js`

**问题**：一封回复邮件的 body 里嵌套着所有历史回复。例如一封 11 万字的邮件，本人新写的只有 200 字，其余全是引用的历史内容。需要把正文拆分成独立的"对话轮次"，每轮对应一个人在一个时间点说的话。

**输入**（一封邮件的原始正文）：
```
黄san 您好

为了方便内部讨论，做了一版故障对应流程。

单
From: Huang Yuanning <yuanning.huang@ntt.com.cn>
Sent: Thursday, April 9, 2026 6:11 PM
To: 田 学東; 劉 盈良

各位好，附件是报价要素权重设置方法的说明书文档。请确认。

黄宇宁
________________________________
From: 田 学東 <tianxd@aquait.co.jp>
Sent: Sunday, April 13, 2026 9:35 AM

黄san  你好！附件是关于报价要素权重设置方法的说明书文档。
```

**输出**（拆分后的轮次）：
```json
[
  {"turn_index": 0, "from_name": "単 続龍", "date": "2026-04-14", "content": "为了方便内部讨论，做了一版故障对应流程。"},
  {"turn_index": 1, "from_name": "Huang Yuanning", "date": "2026-04-09", "content": "附件是报价要素权重设置方法的说明书文档。请确认。"},
  {"turn_index": 2, "from_name": "田 学東", "date": "2026-04-13", "content": "附件是关于报价要素权重设置方法的说明书文档。"}
]
```

**识别的引用格式**：

| 邮件客户端 | 引用格式 | 实际匹配数 |
|-----------|---------|-----------|
| Outlook 中文 | `发件人: X\n发送时间: Y` | 29 封 |
| Outlook 英文 | `From: X\nSent: Y` | 12 封 |
| Outlook 分隔线 | `________________________________` | 4 封 |
| Outlook 日文 | `差出人: X` | 2 封 |
| Gmail 英文 | `On [date], [name] wrote:` | 0 封（当前数据无） |
| Gmail 中文 | `在 [date]，[name] 写道：` | 0 封（当前数据无） |
| 通用分隔线 | `-----Original Message-----` | 0 封 |

**分割算法**：
1. 统一换行符（\r\n → \n）
2. 用正则依次匹配所有引用格式，记录每个匹配的位置和提取到的发件人/日期
3. 按位置排序所有匹配点
4. 第一个匹配点之前的内容 = turn_index=0（这封邮件作者的新增内容）
5. 每两个匹配点之间的内容 = 一个历史轮次
6. 跳过紧跟引用头部的 To:/Subject:/收件人: 等 header 行
7. 每轮内容清理：去掉签名（`--` 行之后）、规范化空行

**兜底策略**：未识别的引用格式，整段正文作为 turn_index=0 存入，交给模型在处理层补充分割。

**验证数据**：68 封邮件 → 648 个轮次。多轮 34 封，单轮 34 封。最深 43 轮（11 万字回复链）。抽查 5 封 turn_index=0，全部无引用泄漏。

### 3.4 技术线程分组

**问题**：判断哪些邮件属于同一个对话链。

**机制**：通过邮件 header 中的 `Message-ID`、`In-Reply-To`、`References` 三个字段建立关联。

```javascript
function computeThreadId(db, messageId, inReplyTo, references) {
  // References 头的第一个 ID 就是对话的起始邮件
  if (references) {
    const firstRef = references.split(/\s+/)[0];
    if (firstRef) return firstRef;
  }
  // 没有 References，通过 In-Reply-To 查库找父邮件的 thread_id
  if (inReplyTo) {
    const parent = db.prepare('SELECT thread_id FROM emails WHERE message_id = ?').get(inReplyTo);
    if (parent) return parent.thread_id;
    return inReplyTo;
  }
  // 新对话
  return messageId;
}
```

**跨文件夹关联**：收件（INBOX）和发件（已发送）的邮件如果属于同一对话链，会有相同的 thread_id。

**验证**：68 封邮件形成 33 条技术线程，最长 8 封。

### 3.5 附件下载与内容提取

**文件**：`extract-attachments.js`

**下载**：同步时将所有附件下载到 `data/attachments/{folder}/{uid}/文件名`。

**内容提取**（用于在 event.md 中描述附件内容）：

| 格式 | 提取方式 | 库 |
|------|---------|-----|
| .xlsx/.xls/.csv | 表头 + 前 5 行数据 + 行列数 | xlsx |
| .docx | 全文提取（截取前 3000 字） | mammoth |
| .pdf | 文本提取（截取前 3000 字） | pdf-parse |
| .zip | 列出包含的文件清单 | adm-zip |
| .txt/.md/.json | 直接读取（截取前 3000 字） | fs |
| .rar/.png/.jpg | 跳过 | - |

**清理机制**：配置 `attachment_retention_days`（默认 30 天），超期的附件文件自动删除，元信息（文件名、类型、大小）永久保留。

**验证**：41 个附件中成功提取 35 个，跳过 6 个（4 个 .rar + 2 个 PDF 解析异常）。

### 3.6 SQLite Schema

```sql
-- 同步状态（per 文件夹的增量断点）
CREATE TABLE sync_state (
  folder    TEXT PRIMARY KEY,
  last_uid  INTEGER DEFAULT 0,
  last_sync TEXT
);

-- 文件夹列表
CREATE TABLE folders (
  path        TEXT PRIMARY KEY,
  name        TEXT,
  special_use TEXT,    -- \Inbox, \Sent, \Drafts, \Trash
  parent_path TEXT,
  synced_at   TEXT
);

-- 邮件主表
CREATE TABLE emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           INTEGER,
  folder        TEXT,
  message_id    TEXT UNIQUE,
  in_reply_to   TEXT,
  thread_id     TEXT,
  from_addr     TEXT,
  from_name     TEXT,
  to_addrs      TEXT,          -- JSON array
  cc_addrs      TEXT,          -- JSON array
  subject       TEXT,
  date          TEXT,
  body_raw      TEXT,          -- 原始提取的正文
  has_attachment INTEGER DEFAULT 0,
  attachments   TEXT,          -- JSON: [{name, type, size, local_path}]
  synced_at     TEXT,
  UNIQUE(uid, folder)
);

-- 对话轮次（回复体分割产物）
CREATE TABLE email_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id    INTEGER REFERENCES emails(id),
  turn_index  INTEGER,         -- 0=本封新增内容, 1+=引用历史
  from_name   TEXT,
  from_addr   TEXT,
  date        TEXT,
  content     TEXT
);

-- 联系人聚合
CREATE TABLE contacts (
  addr          TEXT PRIMARY KEY,
  name          TEXT,
  last_email_at TEXT,
  email_count   INTEGER DEFAULT 0,
  folders       TEXT             -- JSON array
);

-- 全文搜索索引
CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject, body_raw, from_name,
  content='emails', content_rowid='id',
  tokenize='trigram'
);
```

## 四、数据处理层 — 完整工作流

**文件**：`process.js`

### 4.1 过滤

在处理前先过滤掉广告、垃圾邮件等无价值内容。过滤掉的邮件不生成 event.md，但保留在数据库中。

```javascript
const FILTER_RULES = {
  sender_patterns: [
    /noreply@.*apple/i,
    /insideapple\.apple\.com/i,
    /applemusic@/i,
    /news@.*apple/i,
    /no-?reply@/i,
  ],
  subject_patterns: [
    /^<广告>/i,
    /unsubscribe/i,
    /退订/i,
  ]
};
```

过滤是按线程级别的——如果一个线程中的所有邮件都匹配过滤规则，则整条线程被过滤。

### 4.2 项目识别（两层结构）

**核心设计**：一个文件夹内的邮件不是扁平地按话题分，而是先识别项目（大的业务归属），再在项目内识别话题。

**输入**：文件夹内所有技术线程的元信息 + 内容提示

每个线程提供：
- subject（主题）
- participants（参与者列表）
- email_count（邮件数）
- dates（时间范围）
- content_hint（最新一封的 turn_index=0 前 200 字）

**分批策略**：每批最多 12 条线程。原因：本地 9B 模型在 32K context 下，12 条线程的元信息 + prompt ≈ 2K tokens 输入，输出 + thinking ≈ 5K tokens，在 8K max_tokens 预算内可完成。

**Prompt**：

```
你是邮件分析助手。以下是邮件文件夹「{folder}」中的一批邮件线程。

请做两层分组：
第一层：识别这些线程属于哪些"项目"（一个大的业务/主题）
第二层：每个项目内，识别具体的"话题"（项目中的一个具体事项）

例如：一个客户项目下面可能有话题"内部定例会"、"系统测试"、"培训资料"等。
分类原则：
- 业务项目：与某个客户、产品或业务相关的邮件，按项目归组
- 内部系统：公司内部使用的IT系统的通知或讨论
- 个人通知：个人账户、账单、安全提醒等
- 行政通知：放假、考勤、规章制度等
不同性质的邮件不要混在同一个项目里。

线程列表：
{threadList}

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
- 所有线程都必须归入
```

**输出**：项目 → 话题的两层结构，每个话题关联若干 thread_id。

### 4.3 项目合并

**问题**：分批处理导致同一项目在不同批次中被识别为不同名称（如"大成温调"和"大成AI系统"）。

**解决**：所有批次处理完后，将全部项目列表给模型做一次合并判断。

**Prompt**：

```
以下是从邮件中识别出的项目列表。有些项目可能实际上是同一个项目的不同方面。

{projectList}

请判断哪些项目应该合并，返回合并方案。格式：
[{"merged_name":"合并后的项目名","original_indices":[1,2,3]}]

如果某个项目不需要合并，也要列出（original_indices只有自己）。所有项目都必须出现。
```

合并后还做话题去重——同一项目内相同名称的话题合并 thread_ids。

### 4.4 事件脉络生成（event.md）

对每个话题，收集其包含的所有邮件的 turn_index=0 内容和附件提取内容，按时间倒序排列，交给模型生成 Markdown 文档。

**输入构造**：

```javascript
// 每封邮件的输入格式
`[${date}] ${from_name} ${direction}:
${turn0_content}
📎 ${attachment_name} (${size}KB)
内容摘要: ${extracted_content}`
```

其中：
- `turn0_content`：回复体分割后的 turn_index=0（仅这封邮件新增的内容）
- `direction`：[收件] 或 [发件]
- `extracted_content`：附件提取的文本内容（如 Excel 的表头和前几行）

**Prompt**：

```
你是邮件分析助手。以下是项目「{projectName}」中话题「{topicName}」的所有邮件记录。
每封邮件只包含新增内容（已去除引用链）。附件已提取内容摘要。

请生成 markdown 格式的事件文档。时间线按倒序（最新在前）。
附件的关键内容要体现在时间线和附件清单中——不只是文件名，要说明附件讲了什么。
附件清单中的"本地路径"列必须从邮件记录中的路径信息原样保留。

{邮件记录}

直接输出 markdown：

# {topicName}

## 概要
（2-3句话概括来龙去脉和当前状态）

## 参与者
（列出参与者及其角色/公司）

## 时间线（最新在前）

### YYYY-MM-DD — 发件人 [收件/发件]
（核心内容，附件内容要写清楚）

## 附件清单
（表格：文件名 | 日期 | 发送人 | 内容说明 | 本地路径）
```

### 4.5 索引生成

**项目级 _index.md**：列出项目下所有话题，每个话题有参与者、时间范围、邮件数、概要（从 event.md 提取）。

**文件夹级 _index.md**：列出文件夹下所有项目，每个项目有话题数、邮件数、话题列表。按最新活动时间倒序排列。包含链接可跳转到项目 _index.md。

### 4.6 跨文件夹关联检查

所有文件夹处理完后，将各文件夹的项目/话题列表给模型做一次关联判断（如收件箱的某项目和已发送的某项目是否是同一件事）。关联结果写入 `_associations.md`。

## 五、增量处理

### 5.1 邮件获取增量（sync.js）

每个文件夹维护 `last_uid`，每次只拉 UID 大于 last_uid 的新邮件。

- 首次：全量拉取（按 initial_days 配置限制范围）
- 日常：增量拉取，通常 0-3 封新邮件，秒级完成

### 5.2 模型处理增量（process.js --incremental）

全量处理时保存 `_process_state.json`，包含：
- `last_processed_ids`：已处理的邮件 ID 列表
- `thread_event_mapping`：thread_id → {project, topic} 的映射

增量处理逻辑：
1. 找出未处理的新邮件（不在 last_processed_ids 中）
2. 过滤广告/垃圾邮件
3. 每封新邮件：
   - 有已知 thread_id（在 mapping 中）→ 追加到已有事件的 event.md
   - 新 thread_id → 模型判断归入哪个项目/话题，或创建新的
4. 更新处理状态

### 5.3 运行方式

```bash
# 首次
node sync.js                    # 全量拉取
node process.js                 # 全量处理

# 日常（cron 每 5 分钟）
node sync.js && node process.js --incremental
```

## 六、产出文件结构

```
data/
├── mail.db                                 ← SQLite 数据库
├── attachments/                            ← 附件存储
│   ├── INBOX/{uid}/文件名
│   └── 已发送/{uid}/文件名
└── events/                                 ← Markdown 知识库
    ├── INBOX/
    │   ├── _index.md                       ← 收件箱概览
    │   ├── 大成AI系统/                      ← 项目
    │   │   ├── _index.md                   ← 项目概览
    │   │   ├── 内部定例会/event.md          ← 事件脉络
    │   │   ├── 测试结果更新/event.md
    │   │   └── 操作视频培训/event.md
    │   ├── 系统通知/
    │   │   ├── _index.md
    │   │   └── Atomos系统更新/event.md
    │   └── ...
    ├── 已发送/
    │   ├── _index.md
    │   └── .../
    ├── _associations.md                    ← 跨文件夹关联
    └── _process_state.json                 ← 处理状态
```

### event.md 格式规范

```markdown
# 话题名称

## 概要
2-3句话概括来龙去脉和当前状态。

## 参与者
- 姓名 (公司/部门)
- ...

## 时间线（最新在前）

### 2026-04-14 — 発件人 [收件]
核心内容...
📎 附件名.xlsx: 包含XX数据，6列×45行

### 2026-04-10 — 発件人 [收件]
核心内容...

## 附件清单
| 文件名 | 日期 | 发送人 | 内容说明 | 本地路径 |
| :--- | :--- | :--- | :--- | :--- |
| 文件.xlsx | 2026-04-14 | 某人 | 包含XX数据 | data/attachments/INBOX/3260/文件.xlsx |
```

## 七、模型配置

### 模型选择

- **模型**：Qwen3.5-9B-Q4_K_M（GGUF 格式，约 5.7GB）
- **推理引擎**：llama.cpp（llama-server）
- **量化**：Q4_K_M（4bit 量化，平衡精度和速度）

### Qwen3.5 Thinking 模式配置

Qwen3.5 默认启用 thinking 模式（`<think>...</think>` 标签），thinking 过程会消耗 `max_tokens` 预算。如果不加控制，thinking 会耗尽所有 token，导致 content 输出为空。

**关键参数**：

```bash
llama-server \
  -m /models/Qwen3.5-9B-Q4_K_M.gguf \
  --reasoning-budget 2048 \                    # thinking 最多 2048 tokens
  --reasoning-budget-message "OK, output the JSON answer now." \  # 预算耗尽时注入的提示
  --cache-type-k turbo4 \                      # KV cache 优化
  --cache-type-v turbo4 \
  -c 32768 \                                   # context 长度
  -fa on \                                     # flash attention
  --host 0.0.0.0 \
  --port 8080 \
  -ngl 99                                      # GPU layers
```

`--reasoning-budget 2048` 限制 thinking token 数。`--reasoning-budget-message` 在 thinking 预算耗尽时自动注入一条消息到 `</think>` 标签之前，引导模型停止思考开始输出。

### Docker 部署

```bash
docker run -d \
  --name llama-tq \
  --gpus all \
  -v /path/to/models:/models \
  -p 8090:8080 \
  llama-tq:latest \
  -m /models/Qwen3.5-9B-Q4_K_M.gguf \
  --cache-type-k turbo4 --cache-type-v turbo4 \
  -c 32768 -fa on --host 0.0.0.0 --port 8080 -ngl 99 \
  --reasoning-budget 2048 \
  --reasoning-budget-message "OK, output the JSON answer now."
```

### API 调用

标准 OpenAI 兼容接口：

```javascript
const response = await fetch('http://host:8090/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'Qwen3.5-9B-Q4_K_M.gguf',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 8000
  })
});

// 返回
// response.choices[0].message.content         → 实际输出
// response.choices[0].message.reasoning_content → thinking 过程
```

### 性能参考（单卡 GPU）

| 操作 | 耗时 |
|------|------|
| 生成速度 | ~93 tok/s |
| 事件识别（10条线程） | ~22s |
| event.md 生成（1个话题） | ~30-60s |
| 全量处理（68封邮件） | ~15min |
| 增量处理（1-3封新邮件） | ~30s |

## 八、配置文件

```json
{
  "account": {
    "name": "账户名",
    "email": "your@email.com",
    "password": "密码或授权码",
    "imap": { "host": "imap.xxx.com", "port": 993, "tls": true },
    "smtp": { "host": "smtp.xxx.com", "port": 465, "tls": true }
  },
  "sync": {
    "folders_skip": ["草稿箱", "已删除"],
    "initial_days": 30,
    "attachment_retention_days": 30
  },
  "model": {
    "base_url": "http://gpu-server:8090/v1",
    "api_key": "none",
    "model_name": "Qwen3.5-9B-Q4_K_M.gguf"
  }
}
```

## 九、已知问题与改进方向

1. **分批处理导致跨批次归类不一致**：已通过合并步骤缓解，但仍可能出现同一项目在不同批次被识别为相似但不完全相同的名称
2. **PDF 提取不稳定**：pdf-parse 库在 Node.js 22 下有兼容问题，部分 PDF 提取失败
3. **RAR 格式不支持**：Node.js 缺乏稳定的 RAR 解析库，当前跳过 .rar 附件
4. **263 邮箱 IMAP 限制**：SEARCH BODY 不可靠、\Answered flag 不维护、STATUS 与 SELECT 计数不一致
5. **模型分类精度**：9B 量化模型对复杂业务场景的分类准确率有限，偶尔会把不相关的邮件归入同一项目

## 十、文件清单

```
mail-refinery/
├── sync.js              ← 数据获取：IMAP 增量同步
├── split-replies.js     ← 数据获取：回复体分割
├── extract-attachments.js ← 数据获取：附件内容提取
├── schema.js            ← 数据获取：SQLite schema 初始化
├── process.js           ← 数据处理：项目识别 + event.md 生成
├── config.json          ← 配置文件
├── package.json         ← 依赖
├── README.md            ← 本文档
├── ARCHITECTURE.md      ← 架构设计文档
└── data/                ← 运行产出（不入库）
    ├── mail.db
    ├── attachments/
    └── events/
```
