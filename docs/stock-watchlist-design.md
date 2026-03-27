# Stock Watchlist 功能设计

## 概述

在现有 briefing MCP server 上扩展，增加股票关注列表（watchlist）功能。  
用户可以定制多支股票，每只股票有独立的关注侧重面和信源配置。  
新闻按 **强利好 / 弱利好 / 中性 / 弱利空 / 强利空** 五档分类。  
可独立使用（"看看我的股票"），也可合并到每日简报中呈现。

---

## 1. 数据结构

### Watchlist 存储（`watchlist.json`，按 token 隔离）

```jsonc
{
  "AAPL": {
    "name": "Apple Inc.",
    "market": "US",           // US | ASX
    "sector": "Technology",   // 用于匹配行业信源和默认侧重面
    "focus": [                // 用户定制的侧重面
      "executive_trades",
      "earnings",
      "product_launch",
      "competitor_share",
      "regulatory"
    ],
    "optin_sources": ["SEC EDGAR", "Seeking Alpha"],  // 用户主动启用的可选信源
    "custom_sources": [],     // 用户手动追加的 RSS/关键词
    "added_at": "2026-03-27T..."
  },
  "CBA.AX": {
    "name": "Commonwealth Bank",
    "market": "ASX",
    "sector": "Financials",
    "focus": [
      "executive_trades",
      "earnings",
      "interest_rate_policy",
      "regulatory"
    ],
    "optin_sources": ["ASX Announcements"],
    "custom_sources": [
      { "type": "rss", "url": "https://..." }
    ],
    "added_at": "2026-03-27T..."
  }
}
```

### 默认侧重面目录（`FOCUS_CATALOG`）

每个侧重面有 id、标签、描述、关联搜索关键词：

| id | 标签 | 说明 | 搜索关键词模板 |
|---|---|---|---|
| `executive_trades` | 高管增减持 | 内部人士买入/卖出 | `{ticker} insider trading OR executive buy OR sell` |
| `earnings` | 财报与业绩 | 季报、年报、业绩预告 | `{ticker} earnings OR revenue OR profit OR guidance` |
| `product_launch` | 产品发布 | 新产品、重大更新 | `{ticker} OR {company} product launch OR release OR announce` |
| `competitor_share` | 竞争对手动态 | 市场份额变化 | `{sector} market share OR competitor` |
| `regulatory` | 监管政策 | 行业法规、反垄断、合规 | `{ticker} OR {sector} regulation OR policy OR antitrust` |
| `supply_chain` | 供应链 | 供应链中断/调整 | `{company} supply chain OR supplier OR shortage` |
| `analyst_rating` | 分析师评级 | 升降级、目标价 | `{ticker} analyst upgrade OR downgrade OR target price` |
| `litigation` | 诉讼合规 | 重大法律事件 | `{ticker} lawsuit OR litigation OR SEC investigation` |
| `ma_partnership` | 并购合作 | 收购、战略合作 | `{ticker} acquisition OR merger OR partnership` |
| `buyback_dividend` | 回购分红 | 资本回报政策变化 | `{ticker} buyback OR share repurchase OR dividend` |
| `interest_rate_policy` | 利率政策 | 央行利率决议影响 | `{market_region} interest rate OR central bank OR RBA OR Fed` |
| `macro_outlook` | 宏观经济 | GDP、通胀、就业等 | `{market_region} economy OR GDP OR inflation` |

用户添加股票时，server 根据 `market` + `sector` 自动推荐一组默认侧重面，  
用户可以增删调整。

### 默认侧重面推荐逻辑

```
所有股票默认: executive_trades, earnings, product_launch, regulatory

按 sector 追加:
  Technology  → competitor_share, supply_chain
  Financials  → interest_rate_policy, macro_outlook
  Healthcare  → regulatory (加重), litigation
  Energy      → macro_outlook, supply_chain
  Consumer    → competitor_share, product_launch (加重)

按 market 追加:
  US  → analyst_rating (美股分析师覆盖充分)
  ASX → interest_rate_policy (RBA 影响大), macro_outlook
```

---

## 2. 信源策略

### 核心原则：默认启用 vs 用户主动启用

为避免合规和责任问题，信源分为两类：

**🟢 默认启用（Default Sources）** — 公开免费、无使用条款限制
用户添加股票时自动挂载，无需确认。

**🟡 可选信源（Opt-in Sources）** — 有使用条款、频率限制或合规要求
添加股票时 Claude 提示用户："以下信源可以额外启用，请了解其使用条款后自行决定"。
用户明确说"加上"才启用，选择存入 watchlist 配置。

### 美股 (US)

#### 🟢 默认启用

| 信源 | URL 模板 | 说明 |
|---|---|---|
| **Yahoo Finance RSS** | `https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US` | 按 ticker 的新闻聚合，覆盖面广，实测可用 ✅ |
| **Google News US** | `https://news.google.com/rss/search?q={ticker}+OR+%22{company}%22&hl=en-US&gl=US&ceid=US:en` | ticker + 公司名搜索，兜底覆盖全网 |
| **Nasdaq RSS** | `https://www.nasdaq.com/feed/rssoutbound?symbol={ticker}` | Nasdaq 官方该 ticker 新闻流 |

#### 🟡 用户主动启用

| 信源 | URL 模板 | 说明 | 提示语 |
|---|---|---|---|
| **SEC EDGAR** | RSS: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type=&dateb=&owner=exclude&count=20&output=atom` | 公司 filings（10-K, 8-K, Form 4）。需 ticker→CIK 映射 | "SEC EDGAR 提供官方 filings 数据（含高管增减持），公开免费但有频率限制，需配置 User-Agent" |
| **Seeking Alpha** | `https://seekingalpha.com/api/sa/combined/{ticker}.xml` | 个股深度分析文章 + 新闻 | "Seeking Alpha RSS 仅限个人非商业使用（详见其 Terms of Use）" |

### 澳股 (ASX)

#### 🟢 默认启用

| 信源 | URL 模板 | 说明 |
|---|---|---|
| **Google News AU** | `https://news.google.com/rss/search?q={ticker}+ASX+OR+%22{company}%22&hl=en-AU&gl=AU&ceid=AU:en` | 澳洲区域 Google News，最可靠的兜底方案 |
| **The Market Herald** | `https://themarketonline.com.au/feed` | 澳股综合新闻 RSS（全量，server 端按 ticker/company 关键词过滤） |
| **Stockhead** | `https://stockhead.com.au/feed` | 澳股新闻 RSS（全量，server 端过滤） |

#### 🟡 用户主动启用

| 信源 | URL 模板 | 说明 | 提示语 |
|---|---|---|---|
| **ASX Announcements** (第三方) | `http://finance.mooh.org/rss.php?s={asx_code}` | 按 ticker 的 ASX 公告，5 分钟更新 | "这是非官方第三方服务，可能不稳定" |

#### ASX 备用策略

`finance.mooh.org` 是第三方服务，稳定性无法保证。备用方案：
1. **主方案失败时自动降级**：如果 `mooh.org` 返回错误或超时，自动切换到 Google News AU（用 `{ticker} ASX announcement` 作为搜索词）
2. **ASX 官网抓取**（P2 考虑）：ASX 的公告页 `https://www.asx.com.au/asx/v2/statistics/announcements.do?by=asxCode&asxCode={ticker}&timeframe=D` 虽然不提供 RSS，但返回结构化 HTML，可以后续考虑轻量解析
3. **Investing.com AU** 作为补充：`https://au.investing.com/rss/news.rss`（全量财经新闻，server 端过滤）

### 通用财经 RSS（所有 market 共享，🟢 默认启用）

| 信源 | URL | 说明 |
|---|---|---|
| **CNBC Finance** | `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664` | 通用财经，server 端按 ticker/company 关键词过滤 |
| **Reuters (via Google News)** | `https://news.google.com/rss/search?q=site:reuters.com+{ticker}&hl=en` | 通过 Google News 的 `site:` 操作符获取 Reuters 报道 |

### 社区/讨论信源（🟢 默认启用）

| 信源 | 策略 | URL 模板 |
|---|---|---|
| **Reddit — 美股** | r/stocks, r/wallstreetbets, r/investing, r/StockMarket | `https://www.reddit.com/r/{subreddit}/search.json?q={ticker}&sort=new&t=day` |
| **Reddit — 澳股** | r/ASX_Bets, r/AusFinance | 同上 |
| **Hacker News** | 用公司名/产品名做关键词匹配 | 复用现有 HN 抓取逻辑 |

### Claude Web Search 补充（运行时，无需 server 参与）

Claude 在做利好/利空分析时，通过 tool description 引导主动 web search：
- 查证公司官网 IR / Newsroom 页面
- 搜索最新的分析师评级和目标价
- 验证传闻类消息的真实性
- 查找竞争对手动态（侧重面 `competitor_share` 触发时）

→ 这层是 Claude 的原生能力，不需要 server 做任何事。

### 信源匹配逻辑（`STOCK_SOURCE_CATALOG`）

```typescript
interface SourceEntry {
  type: "rss" | "sec";
  name: string;
  url?: string;        // rss type
  cik_lookup?: boolean; // sec type
}

interface MarketSourceConfig {
  default_per_ticker: SourceEntry[];    // 🟢 默认，按 ticker 精确匹配
  default_filtered: SourceEntry[];      // 🟢 默认，全量抓取后 server 过滤
  optin_per_ticker: SourceEntry[];      // 🟡 可选，需用户确认
  optin_notice: Record<string, string>; // 每个可选信源的提示语
  reddit: string[];                     // 🟢 默认
  fallbacks: Record<string, string>;    // 信源失败时的降级 URL
}

const STOCK_SOURCE_CATALOG: Record<string, MarketSourceConfig> = {
  US: {
    default_per_ticker: [
      { type: "rss", name: "Yahoo Finance",  url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US" },
      { type: "rss", name: "Google News US", url: "https://news.google.com/rss/search?q={ticker}+OR+%22{company}%22&hl=en-US&gl=US&ceid=US:en" },
      { type: "rss", name: "Nasdaq",         url: "https://www.nasdaq.com/feed/rssoutbound?symbol={ticker}" },
    ],
    default_filtered: [
      { type: "rss", name: "CNBC Finance",   url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664" },
    ],
    optin_per_ticker: [
      { type: "sec", name: "SEC EDGAR",      cik_lookup: true },
      { type: "rss", name: "Seeking Alpha",  url: "https://seekingalpha.com/api/sa/combined/{ticker}.xml" },
    ],
    optin_notice: {
      "SEC EDGAR":     "SEC EDGAR 提供官方 filings（含高管增减持 Form 4），公开免费但有频率限制",
      "Seeking Alpha": "Seeking Alpha RSS 仅限个人非商业使用（详见其 Terms of Use）",
    },
    reddit: ["stocks", "wallstreetbets", "investing", "StockMarket"],
    fallbacks: {},
  },
  ASX: {
    default_per_ticker: [
      { type: "rss", name: "Google News AU",   url: "https://news.google.com/rss/search?q={ticker}+ASX+OR+%22{company}%22&hl=en-AU&gl=AU&ceid=AU:en" },
    ],
    default_filtered: [
      { type: "rss", name: "The Market Herald", url: "https://themarketonline.com.au/feed" },
      { type: "rss", name: "Stockhead",         url: "https://stockhead.com.au/feed" },
    ],
    optin_per_ticker: [
      { type: "rss", name: "ASX Announcements", url: "http://finance.mooh.org/rss.php?s={ticker}" },
    ],
    optin_notice: {
      "ASX Announcements": "非官方第三方服务（finance.mooh.org），可能不稳定",
    },
    reddit: ["ASX_Bets", "AusFinance"],
    fallbacks: {
      // mooh.org 失败时，降级为 Google News 搜索 ASX 公告
      "ASX Announcements": "https://news.google.com/rss/search?q={ticker}+ASX+announcement&hl=en-AU&gl=AU&ceid=AU:en",
    },
  },
};
```

### Watchlist 数据结构中的信源配置

用户的 watchlist entry 里记录启用了哪些可选信源：

```jsonc
{
  "AAPL": {
    "name": "Apple Inc.",
    "market": "US",
    "sector": "Technology",
    "focus": ["executive_trades", "earnings", ...],
    "optin_sources": ["SEC EDGAR", "Seeking Alpha"],  // 用户主动启用的
    "custom_sources": [],                              // 用户手动追加的 RSS
    "added_at": "2026-03-27T..."
  },
  "CBA.AX": {
    "name": "Commonwealth Bank",
    "market": "ASX",
    "sector": "Financials",
    "focus": ["executive_trades", "earnings", ...],
    "optin_sources": ["ASX Announcements"],
    "custom_sources": [],
    "added_at": "2026-03-27T..."
  }
}
```

### SEC EDGAR 集成细节（仅在用户启用时激活）

SEC 是美股高管增减持（Form 4）和重大事件（8-K）的权威来源。集成步骤：

1. **Ticker → CIK 映射**：首次启用美股 SEC 源时，从 `https://www.sec.gov/files/company_tickers.json` 下载映射表缓存本地
2. **RSS 订阅**：`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik_padded}&type=&dateb=&owner=exclude&count=20&output=atom`
3. **按 filing type 过滤**：
   - Form 4 → 侧重面 `executive_trades`（高管增减持）
   - 8-K → 侧重面 `earnings`, `ma_partnership`, `litigation` 等（重大事件）
   - 10-K/10-Q → 侧重面 `earnings`（季报/年报）
4. **User-Agent 要求**：SEC 要求请求头包含 `User-Agent: briefing-mcp contact@example.com`（项目级配置，所有用户共用）

### README 中的免责声明（草稿）

```markdown
## Disclaimer

This tool aggregates publicly available information from third-party RSS feeds
and APIs. Some optional data sources (SEC EDGAR, Seeking Alpha) have their own
terms of use — by enabling them, you agree to comply with those terms.

This is not financial advice. The sentiment analysis (bullish/bearish) is
generated by an AI model and should not be used as the sole basis for
investment decisions. Always do your own research.
```

---

## 3. 新增 MCP Tools

### 3.1 `briefing_watchlist_set`

```
用户说"帮我关注苹果"、"加一只股票"、"我想跟踪 CBA" 时调用。

输入:
  token: string
  ticker: string          // "AAPL", "CBA.AX"
  name: string            // "Apple Inc."
  market: "US" | "ASX"
  sector?: string         // 可选，不填则由 Claude 判断
  focus?: string[]        // 可选，不填则用默认推荐
  custom_sources?: [...]  // 可选

输出:
  添加成功 + 推荐的默认侧重面（让 Claude 告诉用户并确认）
```

### 3.2 `briefing_watchlist_get`

```
用户说"我关注了哪些股票"、"看看我的 watchlist" 时调用。

输入: token
输出: 完整 watchlist + 每只股票的侧重面配置
```

### 3.3 `briefing_watchlist_remove`

```
输入: token, ticker
输出: 确认移除
```

### 3.4 `briefing_watchlist_update_focus`

```
用户说"AAPL 我不想看供应链的消息了"、"CBA 加上分析师评级" 时调用。

输入: token, ticker, add_focus?: string[], remove_focus?: string[]
输出: 更新后的侧重面
```

### 3.5 `briefing_stock_fetch`

```
用户说"看看我的股票有什么消息"、"股票有什么新动态" 时调用。

输入:
  token: string
  tickers?: string[]    // 可选，不填则抓所有 watchlist
  hours_back?: number   // 默认 24

逻辑:
  1. 读取 watchlist
  2. 对每只股票，根据 market 匹配结构化信源
  3. 用 ticker/company name 做关键词，抓取 RSS + Reddit + HN
  4. 去重、按时间排序、存入缓存

输出:
  { total: 47, by_ticker: { "AAPL": 23, "CBA.AX": 14, ... } }
```

### 3.6 `briefing_stock_digest`

```
获取已抓取的股票新闻列表，供 Claude 做分析。

输入: token, ticker?: string
输出:
  文章列表 + 该股票的侧重面配置
  （Claude 根据侧重面 + 文章内容，判断利好/利空及权重）
```

---

## 4. Claude 端的利好/利空分析

不写死在 server 里，通过 tool description 引导 Claude：

```
briefing_stock_digest 的 description:

"获取关注股票的相关新闻。拿到数据后请：
 1. 根据该股票的侧重面（focus）逐条分析
 2. 每条新闻标注：
    🟢🟢 强利好 | 🟢 弱利好 | ⚪ 中性 | 🔴 弱利空 | 🔴🔴 强利空
 3. 跟侧重面无关但重大的消息也要标注
 4. 对🟢🟢和🔴🔴级别的消息，用web search查证官方来源
 5. 最后给一句整体情绪总结"
```

---

## 5. 与每日简报的集成

在现有的 `daily-briefing` prompt 里扩展：

```
现有流程:
  fetch articles → get articles → Claude 按画像筛选 → 呈现

扩展后:
  fetch articles → get articles → Claude 按画像筛选 → 呈现新闻简报
  ↓ (如果 watchlist 不为空)
  stock fetch → stock digest → Claude 分析利好利空 → 呈现股票板块
```

Claude 在每日简报的末尾追加一个「关注股票动态」板块，  
或者用户可以单独说"看看我的股票"只触发股票部分。

---

## 6. 用户体验流程

### 首次设置
```
用户: 帮我关注一下苹果和 CBA
Claude: 好的，我帮你加上：
  • AAPL (Apple) — 美股科技股
    默认关注：高管增减持、财报、产品发布、监管、竞争对手、供应链
  • CBA.AX (Commonwealth Bank) — 澳股金融股
    默认关注：高管增减持、财报、监管、利率政策、宏观经济
  
  这些侧重面你要调整吗？比如加上"分析师评级"或去掉某项？

用户: AAPL 加上分析师评级，CBA 不用改
Claude: [调用 watchlist_update_focus] 搞定。
```

### 日常使用
```
用户: 看看我的股票
Claude: [调用 stock_fetch → stock_digest]

📊 AAPL (Apple) — 整体偏利好
🟢🟢 苹果宣布 $1000 亿回购计划（经 Apple IR 确认）
🟢  iPhone 17 供应链消息积极，显示备货量同比增长
🔴  欧盟新数字市场法案可能限制 App Store 定价
⚪  库克出席达沃斯论坛，未有实质性公告

📊 CBA.AX — 整体中性偏利空
🔴🔴 RBA 暗示可能再次加息（RBA 官网声明已确认）
🟢  CBA 数字银行用户数突破 800 万
⚪  澳洲 GDP 数据符合预期
```

---

## 7. 实现优先级

| 阶段 | 内容 | 新增/修改文件 |
|---|---|---|
| P0 | watchlist CRUD + 默认侧重面 | 新增 `watchlist.ts` |
| P0 | stock fetch（RSS + Reddit） | 扩展 `sources.ts` 或新增 `stock-sources.ts` |
| P0 | stock digest + tool descriptions | 修改 `server.ts` |
| P1 | 市场信源自动匹配（SEC/ASX RSS） | 扩展 `stock-sources.ts` |
| P1 | 集成到每日简报 prompt | 修改 `server.ts` prompts |
| P2 | 用户自定义信源（手动加 RSS） | 扩展 `watchlist.ts` |
| P2 | 历史分析（某只股票过去一周的情绪趋势） | 新增或扩展 `interaction-log.ts` |

---

## 8. 待确认

- [x] ~~默认侧重面目录~~ → 已确认，12 项
- [x] ~~是否需要支持 A 股~~ → 不需要
- [x] ~~财经 RSS 信源~~ → 已调研完成，分为默认/可选两类
- [x] ~~ticker 输入格式~~ → 美股 `AAPL`、澳股 `CBA.AX`
- [x] ~~SEC User-Agent~~ → 项目级配置，所有用户共用，填开发者邮箱
- [x] ~~Seeking Alpha 限制~~ → 作为可选信源，README 注明 + 启用时提示用户
- [x] ~~ASX 备用方案~~ → mooh.org 失败时降级到 Google News AU 搜索
- [x] ~~港股~~ → 暂不支持
- [x] ~~信源责任~~ → 默认/可选分层，README 加 Disclaimer

**全部确认完毕，可以开始写代码。**
