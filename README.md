# mail-refinery

企业邮件 AI 精炼管线 — IMAP 增量同步 → 回复体分割 → 本地模型结构化处理 → Markdown 知识库。

## 快速开始

### 环境要求

- Node.js >= 22
- 本地模型服务（llama.cpp + Qwen3.5-9B 或兼容 OpenAI API 的其他模型）

### 安装

```bash
git clone git@github.com:Marvinngg/mail-refinery.git
cd mail-refinery
npm install
```

### 配置

复制并编辑配置文件：

```bash
cp config.example.json config.json
```

```json
{
  "account": {
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
    "base_url": "http://your-gpu-server:8090/v1",
    "api_key": "none",
    "model_name": "Qwen3.5-9B-Q4_K_M.gguf"
  }
}
```

### 模型部署

使用 llama.cpp 部署 Qwen3.5（需配置 reasoning-budget 控制 thinking token 消耗）：

```bash
docker run -d --name llama-tq --gpus all \
  -v /path/to/models:/models -p 8090:8080 \
  llama-tq:latest \
  -m /models/Qwen3.5-9B-Q4_K_M.gguf \
  --reasoning-budget 2048 \
  --reasoning-budget-message "OK, output the JSON answer now." \
  -c 32768 -fa on --host 0.0.0.0 --port 8080 -ngl 99
```

### 运行

```bash
# 1. 首次：拉取邮件并同步到本地数据库
node sync.js

# 2. 首次：模型处理，生成结构化 Markdown
node process.js

# 3. 日常增量（建议 cron 每 5 分钟）
node sync.js && node process.js --incremental
```

### 产出

处理完成后在 `data/events/` 下生成 Markdown 知识库：

```
data/events/
├── INBOX/
│   ├── _index.md                    ← 收件箱概览
│   ├── 项目A/
│   │   ├── _index.md                ← 项目概览
│   │   ├── 话题1/event.md           ← 事件脉络（含附件内容）
│   │   └── 话题2/event.md
│   └── 项目B/
│       └── ...
├── 已发送/
│   └── ...
└── _process_state.json              ← 增量处理状态
```

## 文件说明

| 文件 | 用途 |
|------|------|
| `sync.js` | IMAP 增量同步（按文件夹拉取邮件、回复体分割、附件下载） |
| `split-replies.js` | 回复体分割（识别 Outlook/Gmail 等引用格式，拆分对话轮次） |
| `extract-attachments.js` | 附件内容提取（xlsx/docx/pdf/zip） |
| `schema.js` | SQLite 数据库初始化 |
| `process.js` | 模型处理（项目识别、事件脉络生成、索引生成） |
| `config.json` | 配置（邮箱账户、同步参数、模型地址） |
| `GUIDE.md` | 完整架构设计文档（含工作流、Prompt、技术细节） |

## 架构

详见 [GUIDE.md](./GUIDE.md)

## License

MIT
