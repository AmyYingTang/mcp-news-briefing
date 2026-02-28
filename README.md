# 🌅 mcp-news-briefing

一个个性化的AI信息过滤系统，以MCP Server的形式集成到Claude Desktop中。

## 核心理念

> 不是被动接收一封邮件，而是主动打开Claude说"今天有什么值得看的"。

这个系统通过你的兴趣画像对海量信息进行过滤，只把跟你相关的内容呈现出来。画像由你自己定义，信源由你自己选择，过滤由AI完成。不限于AI领域——天文、金融、安全、烹饪，你关注什么就设置什么。

所有数据存在你自己的电脑上，没有云端，没有账号，没有追踪。

**👉 我是用户** — 有人给了我一个 .mcpb 文件，我想开始使用 → [安装与使用](#安装与使用)

**👉 我是开发者** — 我想自己 clone 代码跑起来，或者参与开发 → [开发者指南](#开发者指南)

---

## 安装与使用

### 前置条件

- [Claude Desktop](https://claude.ai/download)（macOS 或 Windows）

就这一个。不需要装其他任何东西。

### 安装

1. 拿到 `briefing-mcp.mcpb` 文件
2. 打开 Claude Desktop → Settings → Extensions → Install Extension
3. 选择这个文件
4. 安装完成

### 注册

跟Claude说：

> "帮我在briefing注册一下，名字叫（你的名字）"

你会拿到一个token，**请保存好**。不过后续你用名字也能识别身份，不用每次贴token。

### 设置画像

有两种方式：

**方式A：问卷引导（推荐）**

> "帮我用问卷设置一下briefing画像"

Claude会通过几个问题了解你的职业、关注领域、不想看的内容，然后自动生成画像。

**方式B：直接告知**

> "帮我设置briefing画像，我关注AI Agent、嵌入式开发、天文摄影，不想看融资新闻"

### 选择信源

画像设好后：

> "帮我推荐一下briefing的信源"

Claude会根据你的画像推荐相关的RSS、Reddit板块等，你确认后就订阅了。也可以自己加：

> "帮我加一个RSS源：https://example.com/feed.xml，名字叫my-blog"

### 开始使用

> "看看今天的简报"

### 日常用法

| 你说的话 | 会发生什么 |
|---------|-----------|
| "看看今天的简报" | 抓取最近24小时 + 过滤 + 呈现（默认8条） |
| "看看这周的简报" | 抓取最近7天的内容 |
| "本月的简报，多给点，20条" | 抓取30天内容，返回20条 |
| "这条展开说说" | 详细分析某条内容 |
| "把这条收藏" | 标记感兴趣的内容 |
| "这周我关注了什么？" | 查看兴趣模式摘要 |
| "加一个关注领域：量子计算" | 动态调整画像 |
| "看看我的信源配置" | 查看当前订阅的信源 |

### 💡 提示

- 画像和信源随时可以调整，不需要重新注册
- 一个人可以注册多个token，比如一个看AI、一个看天文，各自独立
- 信息来源包括RSS、Reddit和Hacker News，覆盖面很广

### 数据存储

所有数据在你本地：

| 系统 | 位置 |
|------|------|
| macOS | `~/Library/Application Support/briefing-mcp/` |
| Windows | `%APPDATA%\briefing-mcp\` |

---

## 开发者指南

### Clone & 运行

```bash
git clone https://github.com/AmyYingTang/mcp-news-briefing.git
cd mcp-news-briefing
npm install
npm run build
```

在 `claude_desktop_config.json` 中添加：

```json
{
  "mcpServers": {
    "briefing": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-news-briefing/dist/server.js"]
    }
  }
}
```

完全退出 Claude Desktop 再重新打开（macOS 用 Cmd+Q，不是关窗口）。

### 打包 .mcpb

```bash
bash build-mcpb.sh
```

产物 `bmcp-news-briefing.mcpb` 可以分发给任何 Claude Desktop 用户安装。

### 项目结构

```
mcp-news-briefing/
├── manifest.json            # MCPB Desktop Extension 清单
├── build-mcpb.sh            # 打包脚本
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── server.ts            # MCP 工具定义 & 启动入口
    ├── storage.ts           # 跨平台数据目录 & JSON 读写
    ├── auth.ts              # Token 注册 / 验证 / 解析
    ├── profile.ts           # 画像 CRUD、问卷、信源推荐库
    ├── sources.ts           # RSS / Reddit / HN 抓取 + 缓存
    ├── user-sources.ts      # 用户信源配置管理
    └── interaction-log.ts   # 互动日志追踪
```

### 架构

```
Claude Desktop
    │ stdio
    ▼
┌──────────────┐
│  MCP Server  │  ← Node.js (Claude Desktop 内置)
│  (TS/SDK)    │
└──────┬───────┘
       │
  ┌────┼────┐
  ▼    ▼    ▼
缓存  画像  信源     ← 按 token 隔离，JSON 文件存储
      日志
```

- **缓存策略：** 同一30分钟窗口内，信源配置相同的请求共享缓存（缓存key含信源配置hash）
- **数据隔离：** 每个token对应 `users/<token前8位>/` 目录，包含独立的 profile.json、sources.json、interaction_log.json

### MCP 工具一览

| 工具名 | 功能 |
|--------|------|
| `briefing_register` | 注册新用户，获取token |
| `briefing_create_profile_interactive` | 画像引导问卷 |
| `briefing_set_profile` | 设置/更新画像 |
| `briefing_get_profile` | 获取画像 |
| `briefing_suggest_sources` | 根据画像推荐信源 |
| `briefing_set_sources` | 按分类ID批量订阅 |
| `briefing_add_sources` | 追加自定义信源 |
| `briefing_get_sources` | 查看信源配置 |
| `briefing_fetch_articles` | 抓取文章（24h/168h/720h） |
| `briefing_get_articles` | 获取已保存文章列表 |
| `briefing_log_interaction` | 记录阅读/讨论/收藏 |
| `briefing_interaction_summary` | 兴趣模式摘要 |
| `briefing_view_log` | 查看互动日志 |

### 新用户完整流程（工具调用顺序）

1. `briefing_register` → 获取token
2. `briefing_create_profile_interactive` → AI引导对话 → `briefing_set_profile` 提交
3. `briefing_suggest_sources` → 用户确认 → `briefing_set_sources` 订阅
4. `briefing_fetch_articles` → `briefing_get_articles` + `briefing_get_profile` → AI过滤分析

### Roadmap

- [x] 多用户 token 隔离
- [x] 画像引导问卷
- [x] 信源推荐引擎
- [x] 互动日志 & 兴趣模式分析
- [x] TypeScript 重写（Node.js 原生，.mcpb 就绪）
- [x] .mcpb Desktop Extension 打包
- [ ] Anthropic Extension Directory 提交
- [ ] OAuth 2.1（远程部署场景）
- [ ] Twitter/X 数据源
- [ ] 画像自动演进（根据互动日志调整关注权重）

## License

MIT
