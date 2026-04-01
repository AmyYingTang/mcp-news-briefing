#!/usr/bin/env node
/**
 * 🌅 AI Briefing — MCP Server (TypeScript)
 *
 * Personalized AI & tech news filtering via MCP tools.
 * Designed for zero-dependency installation via .mcpb Desktop Extension.
 *
 * Usage:
 *   npx mcp-news-briefing          # stdio mode (Claude Desktop)
 *   npx mcp-news-briefing --http   # HTTP mode (remote)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { registerUser, resolveToken, verifyToken, setDefault, getDefaultName, getAllTokens } from "./auth.js";
import { getProfile, setProfile, getProfilePrompt, PROFILE_QUESTIONNAIRE, suggestSources } from "./profile.js";
import { getSources, setSourcesFromCategories, addCustomSources } from "./user-sources.js";
import { fetchAll, loadTodayArticles, loadArticlesByDate, type Article } from "./sources.js";
import { logInteraction, getInteractionSummary, getFullLog } from "./interaction-log.js";
import { log, getUserSettings, setUserSettings } from "./storage.js";
import {
  getWatchlist, setWatchlistEntry, removeWatchlistEntry, updateFocus, updateCustomSources,
  setAlerts, listAlerts, updateAlert, dismissAlerts, expireStaleAlerts, recordAlertTrigger,
  confirmAlertTrigger, appendDuplicateSource,
  getActiveAlertsForTicker, getExpiringAlerts, getNoisyAlerts, setGlobalAlerts,
  FOCUS_CATALOG, type Market, type CustomSource, type AlertInput, type GlobalAlertInput, type AlertScope,
} from "./watchlist.js";
import { fetchStockNews, loadStockArticles, loadDailyStockCache, hasDailyStockCache } from "./stock-sources.js";
import {
  recordSnapshot, getSnapshots, fetchClosePrice, detectDivergence,
  computeSentimentLabel, type SentimentBreakdown, type SentimentSnapshot, type AlertTriggerRecord,
} from "./stock-history.js";

// ── Token validation helper ──────────────────────────────────

function requireToken(token: string): { error?: string; realToken?: string } {
  // resolveToken handles empty string → default fallback
  const realToken = resolveToken(token ?? "");

  if (!realToken) {
    // Distinguish: did the user pass something that didn't match, or was it empty?
    if (!token?.trim()) {
      return {
        error: JSON.stringify({
          status: "error",
          error: "no_default",
          message: "找不到默认用户。请告诉我你的用户名，或先用 briefing_register 注册。",
        }),
      };
    }
    return {
      error: JSON.stringify({
        status: "error",
        error: "invalid_token",
        message: "找不到匹配的用户。可以传入token或注册时的用户名。\n如果还没有注册，请先用 briefing_register 注册。",
      }),
    };
  }

  verifyToken(realToken);
  return { realToken };
}

function countSources(articles: Article[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of articles) {
    const prefix = a.source.includes(":") ? a.source.split(":")[0] : a.source;
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  return counts;
}

// ── Create MCP Server ────────────────────────────────────────

const server = new McpServer({
  name: "mcp-news-briefing",
  version: "0.1.0",
});

// ── Tool: Register ───────────────────────────────────────────

server.tool(
  "briefing_register",
  "注册新闻简报服务。用户说「帮我注册」「我想开始用简报」等时调用。\n返回一个token，后续可以用token或用户名识别身份。",
  { name: z.string().default("").describe("用户名称（可选）") },
  async ({ name }) => {
    const result = registerUser(name);

    const defaultHint = result.is_new
      ? (result.is_default
        ? "\n\n✅ 已设为默认身份，后续无需再指定用户名。"
        : `\n\n你已有默认身份 ${getDefaultName() || "（未知）"}，如需切换可以告诉我。`)
      : "";

    const message = result.is_new
      ? `🎉 注册成功！\n\n**用户名：** ${result.name}\n**Token：** ${result.token}\n\n⚠️ 请保存此token，后续也可以用名字来识别。${defaultHint}\n\n下一步：可以设置你的兴趣偏好，让简报更精准。`
      : `用户 ${result.name} 已存在，无需重复注册。\nToken：${result.token}\n\n可以直接说「看看今天的新闻」开始使用。`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "success", token: result.token, name: result.name, is_new: result.is_new, is_default: result.is_default, message }),
        },
      ],
    };
  }
);

// ── Tool: Set Default Identity ───────────────────────────────

server.tool(
  "briefing_set_default",
  "切换默认身份。用户说「把默认身份切到xxx」「以后默认用xxx的身份」时调用。",
  { token: z.string().describe("要设为默认的 token 或用户名") },
  async ({ token }) => {
    const result = setDefault(token);

    if (!result.success) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "error", error: "user_not_found", message: result.error }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          default_name: result.name,
          message: `已将默认身份切换为 ${result.name}。后续不指定身份时将自动使用此账号。`,
        }),
      }],
    };
  }
);

// ── Tool: Set Profile ────────────────────────────────────────

server.tool(
  "briefing_set_profile",
  "设置或更新用户的兴趣偏好。用户说「我想关注XX」「帮我加个兴趣」「不想再看XX」等时调用。\n只传需要更新的字段，其他保持不变。兴趣偏好是新闻过滤的核心依据。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    profile: z
      .object({
        name: z.string().optional(),
        strengths: z.array(z.string()).optional(),
        active_projects: z.array(z.string()).optional(),
        high_interest: z.array(z.string()).optional(),
        exploration_interest: z.array(z.string()).optional(),
        noise_filter: z.array(z.string()).optional(),
      })
      .describe("兴趣偏好JSON，可包含：\n- name: 名称\n- strengths: 专业特长\n- active_projects: 当前在做的项目\n- high_interest: 重点关注的领域\n- exploration_interest: 想了解但不是核心的领域\n- noise_filter: 不想看到的内容类型"),
  },
  async ({ token, profile }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const updated = setProfile(realToken!, profile);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", profile: updated, message: "兴趣偏好已更新。" }) }],
    };
  }
);

// ── Tool: Profile Questionnaire ──────────────────────────────

server.tool(
  "briefing_create_profile_interactive",
  "通过问答了解用户的兴趣偏好。用户说「帮我设置偏好」「重新设置我关注的内容」等时调用。\n返回引导问题，收集完毕后整理成JSON调用 briefing_set_profile 提交。",
  { token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。") },
  async ({ token }) => {
    const { error } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", ...PROFILE_QUESTIONNAIRE }) }],
    };
  }
);

// ── Tool: Suggest Sources ────────────────────────────────────

server.tool(
  "briefing_suggest_sources",
  "根据用户的兴趣偏好推荐新闻来源（RSS、Reddit、Hacker News）。\n用户说「帮我推荐信源」「有什么好的订阅推荐」等时调用。",
  { token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。") },
  async ({ token }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const result = suggestSources(realToken!);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", ...result }) }],
    };
  }
);

// ── Tool: Set Sources ────────────────────────────────────────

server.tool(
  "briefing_set_sources",
  "按分类订阅新闻来源。用户确认推荐的信源后调用。\n已有的自定义信源会保留。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    category_ids: z
      .array(z.string())
      .describe("信源分类ID列表，如 ['anthropic', 'embedded', 'ai_general']。来自 briefing_suggest_sources 的推荐结果。"),
  },
  async ({ token, category_ids }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const sources = setSourcesFromCategories(realToken!, category_ids);
    const summary = {
      rss_count: Object.keys(sources.rss).length,
      reddit_count: sources.reddit.length,
      hn_keywords_count: sources.hn_keywords.length,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            sources,
            summary,
            message: `信源已更新：${summary.rss_count}个RSS源、${summary.reddit_count}个Reddit板块、${summary.hn_keywords_count}个HN关键词。`,
          }),
        },
      ],
    };
  }
);

// ── Tool: Add Custom Sources ─────────────────────────────────

server.tool(
  "briefing_add_sources",
  "添加自定义新闻来源（追加，不会覆盖已有的）。\n用户说「帮我加一个RSS」「我还想看XX的Reddit」等时调用。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    rss: z.record(z.string()).optional().describe('自定义RSS源，格式 {"名称": "URL"}'),
    reddit: z.array(z.string()).optional().describe('Reddit板块名称列表，如 ["python", "golang"]'),
    hn_keywords: z.array(z.string()).optional().describe('Hacker News过滤关键词，如 ["kubernetes", "docker"]'),
  },
  async ({ token, rss, reddit, hn_keywords }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const sources = addCustomSources(realToken!, { rss, reddit, hn_keywords });
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", sources, message: "自定义信源已添加。" }) }],
    };
  }
);

// ── Tool: Get Sources ────────────────────────────────────────

server.tool(
  "briefing_get_sources",
  "查看当前订阅了哪些新闻来源。用户说「我现在订阅了什么」「看看我的信源」等时调用。",
  { token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。") },
  async ({ token }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const sources = getSources(realToken!);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", sources }) }],
    };
  }
);

// ── Tool: Fetch Articles ─────────────────────────────────────

server.tool(
  "briefing_fetch_articles",
  "从订阅的新闻来源抓取最新内容。用户说「看看今天的新闻」「最近有什么值得看的」「这周的简报」等时，先调用此工具获取数据。\n\n时间范围：24=今天，168=本周，720=本月。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    hours_back: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24)
      .describe("回溯小时数：24=今天（默认），48=最近两天，168=本周，720=本月"),
  },
  async ({ token, hours_back }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const userSources = getSources(realToken!);
    const articles = await fetchAll(hours_back, userSources);

    logInteraction(realToken!, "viewed_briefing", "", "", [], `抓取了${articles.length}条内容`);

    if (articles.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "empty", message: "没有获取到新内容，可能是信源暂时不可用，稍后再试。" }) }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            total_articles: articles.length,
            sources_breakdown: countSources(articles),
            message: `已获取${articles.length}条内容。接下来获取文章列表，根据用户的兴趣偏好进行过滤。`,
          }),
        },
      ],
    };
  }
);

// ── Tool: Get Articles ───────────────────────────────────────

server.tool(
  "briefing_get_articles",
  "获取已抓取的文章列表。返回标题、来源、摘要等，供Claude根据用户的兴趣偏好筛选和分析。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    date: z.string().optional().describe("日期（YYYY-MM-DD），默认今天"),
    limit: z.number().int().min(1).max(200).default(8).describe("返回条数（默认8，想多看可以调大）"),
  },
  async ({ token, date, limit }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const dateStr = date || new Date().toISOString().slice(0, 10);
    const articles = date ? loadArticlesByDate(dateStr) : loadTodayArticles();

    if (articles.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "empty",
              date: dateStr,
              message: `${dateStr} 没有已保存的文章。请先抓取最新内容。`,
            }),
          },
        ],
      };
    }

    const limited = articles.slice(0, limit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "success", date: dateStr, total: articles.length, returned: limited.length, articles: limited }),
        },
      ],
    };
  }
);

// ── Tool: Get Profile ────────────────────────────────────────

server.tool(
  "briefing_get_profile",
  "获取用户的兴趣偏好，包含关注领域、当前项目、不想看的内容等。\n在分析新闻前应先读取，作为筛选依据。",
  { token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。") },
  async ({ token }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            profile: getProfile(realToken!),
            filter_prompt: getProfilePrompt(realToken!),
            instructions:
              "请根据用户的兴趣偏好对文章进行匹配评估。" +
              "将文章分为：🔴高度匹配、🟡中等匹配、⚪低优先级、🚫噪音。" +
              "对每条高匹配文章，说明为什么跟用户相关以及建议的行动。" +
              "\n\n" +
              "【信源查证要求】\n" +
              "对于🔴高度匹配中的重大行业消息（如产品发布、重大更新、公司重要公告等），" +
              "请使用web search查证以下信息并附在该条目中：\n" +
              "1. 官方一手来源链接（官网公告、官方博客等）\n" +
              "2. 实际发布/发生日期（注意区分事件发生日期和被讨论日期，" +
              "   RSS/Reddit抓到的可能是后者）\n" +
              "3. 如果查证发现信息不准确或有出入，明确标注\n" +
              "对于🟡中等匹配和⚪低优先级的条目，附上文章原始链接即可，不需要额外查证。\n" +
              "\n用中文回复。",
          }),
        },
      ],
    };
  }
);

// ── Tool: Log Interaction ────────────────────────────────────

server.tool(
  "briefing_log_interaction",
  "记录用户的阅读行为。当用户展开某条新闻、深入讨论、或收藏时，自动调用。\n用于后续分析用户的兴趣趋势。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    action: z.string().describe("行为类型：read_detail=展开阅读，discussed=深入讨论，saved=收藏，feedback=反馈"),
    article_title: z.string().default("").describe("相关文章标题"),
    article_url: z.string().default("").describe("相关文章链接"),
    topics: z.array(z.string()).default([]).describe("相关话题标签"),
    notes: z.string().default("").describe("备注"),
  },
  async ({ token, action, article_title, article_url, topics, notes }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const entry = logInteraction(realToken!, action, article_title, article_url, topics, notes);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "logged", entry }) }],
    };
  }
);

// ── Tool: Interaction Summary ────────────────────────────────

server.tool(
  "briefing_interaction_summary",
  "分析用户最近的阅读兴趣趋势。用户说「我最近关注了什么」「这周看了些啥」等时调用。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    days: z.number().int().min(1).max(90).default(7).describe("回顾天数（默认7天）"),
  },
  async ({ token, days }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const summary = getInteractionSummary(realToken!, days);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            ...summary,
            instructions:
              "请用中文自然地呈现这个摘要，帮用户看到自己的兴趣趋势。" +
              "如果有明显的话题偏好，指出来。" +
              "如果活跃度有波动，温和地提及（但不要说教）。",
          }),
        },
      ],
    };
  }
);

// ── Tool: View Log ───────────────────────────────────────────

server.tool(
  "briefing_view_log",
  "查看最近的阅读记录明细。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    limit: z.number().int().min(1).max(100).default(20).describe("返回条数"),
  },
  async ({ token, limit }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const entries = getFullLog(realToken!, limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", total_returned: entries.length, entries }) }],
    };
  }
);

// ── Tool: Watchlist Set ──────────────────────────────────────

server.tool(
  "briefing_stock_watchlist_set",
  "添加或更新关注的股票。用户说「帮我关注苹果」「加一只股票」「我想跟踪 CBA」等时调用。\n" +
  "不填 focus 则按 market + sector 自动推荐侧重面，返回推荐结果让用户确认。\n" +
  "可选信源（optin_sources）需用户明确说「加上」才填入，添加前告知用户相应限制说明（optin_notices）。\n\n" +
  "sector 常用值：Technology / Financials / Healthcare / Energy / Consumer / Other",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe('股票代码，美股如 "AAPL"，澳股如 "CBA.AX"'),
    name: z.string().describe('公司全名，如 "Apple Inc."'),
    market: z.enum(["US", "ASX"]).describe("交易市场"),
    sector: z.string().optional().describe("所属行业（可选，不填则用 Other）"),
    focus: z.array(z.string()).optional().describe(
      "侧重面ID列表（可选，不填则自动推荐）。" +
      "可用ID：executive_trades / earnings / product_launch / competitor_share / regulatory / " +
      "supply_chain / analyst_rating / litigation / ma_partnership / buyback_dividend / " +
      "interest_rate_policy / macro_outlook"
    ),
    optin_sources: z.array(z.string()).optional().describe("用户主动启用的可选信源名称列表"),
  },
  async ({ token, ticker, name, market, sector, focus, optin_sources }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const { entry, recommended_focus, optin_notices } = setWatchlistEntry(realToken!, ticker.toUpperCase(), {
      name, market: market as Market, sector, focus, optin_sources,
    });

    const focusLabels = entry.focus.map((id) => {
      const item = FOCUS_CATALOG.find((f) => f.id === id);
      return item ? `${item.label}（${id}）` : id;
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: ticker.toUpperCase(),
          entry,
          recommended_focus,
          focus_labels: focusLabels,
          optin_notices,
          message: `已添加 ${ticker.toUpperCase()} (${name})。当前侧重面：${focusLabels.join("、")}。`,
          instructions: focus
            ? undefined
            : "以上是根据 market + sector 自动推荐的侧重面，请告知用户并询问是否需要调整。如需调整，调用 briefing_stock_watchlist_update_focus。",
        }),
      }],
    };
  }
);

// ── Tool: Watchlist Get ──────────────────────────────────────

server.tool(
  "briefing_stock_watchlist_get",
  "查看关注的股票列表及每只股票的侧重面配置。用户说「我关注了哪些股票」「看看我的 watchlist」等时调用。",
  { token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。") },
  async ({ token }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const wl = getWatchlist(realToken!);
    const count = Object.keys(wl).length;

    if (count === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            message: "还没有关注任何股票。用 briefing_stock_watchlist_set 添加。",
          }),
        }],
      };
    }

    // Annotate each entry with focus labels for readability
    const annotated = Object.fromEntries(
      Object.entries(wl).map(([ticker, entry]) => [
        ticker,
        {
          ...entry,
          focus_labels: entry.focus.map((id) => {
            const item = FOCUS_CATALOG.find((f) => f.id === id);
            return item ? item.label : id;
          }),
        },
      ])
    );

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "success", count, watchlist: annotated }),
      }],
    };
  }
);

// ── Tool: Watchlist Remove ───────────────────────────────────

server.tool(
  "briefing_stock_watchlist_remove",
  "从关注列表中移除股票。用户说「不看 AAPL 了」「把 CBA 从 watchlist 删掉」等时调用。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe("要移除的股票代码，如 AAPL 或 CBA.AX"),
  },
  async ({ token, ticker }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const removed = removeWatchlistEntry(realToken!, ticker.toUpperCase());
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          removed
            ? { status: "success", ticker: ticker.toUpperCase(), message: `已移除 ${ticker.toUpperCase()}。` }
            : { status: "not_found", ticker: ticker.toUpperCase(), message: `未找到 ${ticker.toUpperCase()}，无需操作。` }
        ),
      }],
    };
  }
);

// ── Tool: Watchlist Update Focus ─────────────────────────────

server.tool(
  "briefing_stock_watchlist_update_focus",
  "调整某只股票的关注侧重面。用户说「AAPL 不看供应链了」「CBA 加上分析师评级」等时调用。\n" +
  "add_focus 和 remove_focus 可以同时传，都是侧重面ID列表。\n" +
  "可用ID：executive_trades / earnings / product_launch / competitor_share / regulatory / " +
  "supply_chain / analyst_rating / litigation / ma_partnership / buyback_dividend / " +
  "interest_rate_policy / macro_outlook",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe("股票代码，如 AAPL 或 CBA.AX"),
    add_focus: z.array(z.string()).optional().describe("要新增的侧重面ID列表"),
    remove_focus: z.array(z.string()).optional().describe("要移除的侧重面ID列表"),
  },
  async ({ token, ticker, add_focus, remove_focus }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const updated = updateFocus(realToken!, ticker.toUpperCase(), add_focus, remove_focus);

    if (!updated) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "not_found",
            ticker: ticker.toUpperCase(),
            message: `未找到 ${ticker.toUpperCase()}，请先用 briefing_stock_watchlist_set 添加。`,
          }),
        }],
      };
    }

    const focusLabels = updated.map((id) => {
      const item = FOCUS_CATALOG.find((f) => f.id === id);
      return item ? item.label : id;
    });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: ticker.toUpperCase(),
          focus: updated,
          focus_labels: focusLabels,
          message: `${ticker.toUpperCase()} 侧重面已更新：${focusLabels.join("、")}。`,
        }),
      }],
    };
  }
);

// ── Tool: Watchlist Custom Sources ────────────────────────────

server.tool(
  "briefing_stock_watchlist_custom_sources",
  "管理某只股票的自定义信源（RSS）。用户说「给 AAPL 加一个 RSS 源」「AAPL 删掉那个自定义源」「看看 AAPL 的自定义信源」等时调用。\n" +
  "add_urls 添加 RSS 源，remove_urls 按 URL 移除。两者都不传则仅查看当前自定义信源列表。\n" +
  "URL 支持 {ticker}、{company} 占位符，抓取时自动替换。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe("股票代码，如 AAPL 或 CBA.AX"),
    add_urls: z.array(z.string()).optional().describe("要添加的 RSS 源 URL 列表"),
    remove_urls: z.array(z.string()).optional().describe("要移除的 RSS 源 URL 列表"),
  },
  async ({ token, ticker, add_urls, remove_urls }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const upperTicker = ticker.toUpperCase();

    // View-only mode
    if (!add_urls && !remove_urls) {
      const wl = getWatchlist(realToken!);
      const entry = wl[upperTicker];
      if (!entry) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "not_found",
              ticker: upperTicker,
              message: `未找到 ${upperTicker}，请先用 briefing_stock_watchlist_set 添加。`,
            }),
          }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            ticker: upperTicker,
            custom_sources: entry.custom_sources || [],
            count: (entry.custom_sources || []).length,
            message: (entry.custom_sources || []).length === 0
              ? `${upperTicker} 暂无自定义信源。`
              : `${upperTicker} 有 ${entry.custom_sources.length} 个自定义信源。`,
          }),
        }],
      };
    }

    // Add / Remove
    const addSources: CustomSource[] | undefined = add_urls?.map((url) => ({ type: "rss" as const, url }));
    const updated = updateCustomSources(realToken!, upperTicker, addSources, remove_urls);

    if (updated === null) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "not_found",
            ticker: upperTicker,
            message: `未找到 ${upperTicker}，请先用 briefing_stock_watchlist_set 添加。`,
          }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: upperTicker,
          custom_sources: updated,
          count: updated.length,
          message: `${upperTicker} 自定义信源已更新，当前 ${updated.length} 个。`,
        }),
      }],
    };
  }
);

// ── Tool: Stock Auto Fetch ──────────────────────────────────

server.tool(
  "briefing_stock_auto_fetch",
  "开启或关闭每日自动抓取股票新闻。用户说「帮我开启自动抓取」「关闭自动更新」" +
  "「每天自动帮我更新股票消息」等时调用。\n\n" +
  "当用户首次通过 briefing_stock_watchlist_set 添加股票时，" +
  "应主动问用户是否要开启每日自动抓取，解释其作用（保证趋势数据连续性），并尊重用户的选择。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    enabled: z.boolean().describe("true=开启，false=关闭"),
  },
  async ({ token, enabled }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    setUserSettings(realToken!, { auto_fetch_enabled: enabled });

    const message = enabled
      ? "✅ 已开启每日自动抓取。每次打开 Claude Desktop 时会自动更新你的股票新闻，你不需要手动触发抓取。看趋势时数据会更完整。"
      : "已关闭每日自动抓取。后续需要手动说「看看我的股票」才会触发抓取。";

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          auto_fetch_enabled: enabled,
          message,
        }),
      }],
    };
  }
);

// ── Tool: Stock Fetch ────────────────────────────────────────

server.tool(
  "briefing_stock_fetch",
  "抓取关注股票的最新新闻。用户说「看看我的股票有什么消息」「股票有什么新动态」等时调用。\n" +
  "不传 tickers 则抓取整个 watchlist。抓取后调用 briefing_stock_digest 获取文章列表做分析。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    tickers: z.array(z.string()).optional().describe("只抓取这些 ticker（可选，不填则抓取全部 watchlist）"),
    hours_back: z.number().int().min(1).max(720).default(24).describe("回溯小时数（默认24）"),
  },
  async ({ token, tickers, hours_back }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const wl = getWatchlist(realToken!);
    if (Object.keys(wl).length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            message: "还没有关注任何股票。请先用 briefing_stock_watchlist_set 添加。",
          }),
        }],
      };
    }

    const result = await fetchStockNews(realToken!, hours_back, tickers);

    logInteraction(realToken!, "stock_fetch", "", "", Object.keys(result.by_ticker), `抓取了${result.total}条股票新闻`);

    if (result.total === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            message: "没有获取到股票相关新闻，可能信源暂时不可用，稍后再试。",
          }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          total: result.total,
          by_ticker: result.by_ticker,
          message: `已获取${result.total}条股票新闻。接下来调用 briefing_stock_digest 获取文章列表进行分析。`,
        }),
      }],
    };
  }
);

// ── Tool: Stock Digest ──────────────────────────────────────

server.tool(
  "briefing_stock_digest",
  "获取已抓取的股票新闻列表，供分析利好/利空。核心定位是**帮用户提前看到风险**。拿到数据后请：\n" +
  "1. 根据该股票的侧重面（focus）逐条分析\n" +
  "2. 每条新闻标注：🟢🟢 强利好 | 🟢 弱利好 | ⚪ 中性 | 🔴 弱利空 | 🔴🔴 强利空\n" +
  "3. 跟侧重面无关但重大的消息也要标注\n" +
  "4. 对🟢🟢和🔴🔴级别的消息，用 web search 查证官方来源\n" +
  "5. 检查该股票的 active alerts（返回的 stock_alerts + global_alerts）：\n" +
  "   - 对每条新闻，检查是否命中任一 alert 的 keywords\n" +
  "   - 命中时根据 alert 的 sensitivity 判断相关性：\n" +
  "     loose = 可能相关即触发 / normal = 直接相关才触发 / strict = 确定性进展才触发\n" +
  "   - 判断为相关后，触发前先做事件去重：\n" +
  "     · 提取新闻中的事件日期（事件本身发生的日期，非新闻发布日期）和事件摘要\n" +
  "     · 调用 briefing_stock_alert_trigger 检查是否重复\n" +
  "     · 如果返回 near_date_found + near_entries，比对新闻内容与已有 event_signature：\n" +
  "       - 语义相同 → 调用 action='append_duplicate' 追加来源，不重复触发预警\n" +
  "       - 有实质性进展 → 调用 action='confirm', is_update=true，触发并标注为事件更新\n" +
  "       - 不同事件 → 调用 action='confirm', is_update=false，正常触发\n" +
  "   - 触发的新闻用 ⚠️ 标注并附上 alert 描述\n" +
  "   - 事件更新用 ⚠️🔄 标注，附上\"此前已有相关预警，本次为事件进展\"\n" +
  "   - 触发后立即 web search 深度查证，侧重\"这个风险有多大、是否需要关注\"\n" +
  "   - 通用预警触发用 🌐⚠️ 标注\n" +
  "6. 呈现顺序：预警触发和利空消息优先排列，利好消息正常列出但不渲染成\"机会\"\n" +
  "7. 整体情绪总结\n" +
  "8. 如有 alert 被触发，在总结末尾单独列出预警触发情况，并调用 briefing_stock_alert_trigger 记录\n" +
  "9. 分析完成后，调用 briefing_stock_history_record 记录情绪快照（含 alert_triggers）\n" +
  "10. 如果历史快照 >= 5 天（通过返回的 divergence 字段判断），检查情绪与股价背离：\n" +
  "   - 情绪偏正面 + 股价跌 + alert 触发利空 → 预警捕捉到了尚未被充分定价的风险，重点提示\n" +
  "   - 情绪偏正面 + 股价跌 + 无 alert 触发 → 可能遗漏了某个风险信号，建议用户检查是否需要补设预警\n" +
  "   - 将背离分析作为单独板块呈现\n" +
  "11. 不要主动给出买入/卖出/加仓/减仓建议，只提供风险信息\n" +
  "12. 使用中性语气呈现所有信息：\n" +
  "    - 不说\"建议关注\"、\"持续关注\"、\"值得注意\"、\"需要警惕\"，说\"以下是匹配到的消息\"或直接呈现内容\n" +
  "    - 不说\"风险较大\"、\"情况不乐观\"、\"前景堪忧\"，说\"新闻情绪偏负面\"并附上具体新闻\n" +
  "    - 不说\"利好消息令人鼓舞\"、\"表现强劲\"，说\"新闻情绪偏正面\"并附上具体新闻\n" +
  "    - 不说\"可以考虑...\"、\"或许应该...\"，只呈现信息，不引导任何行动\n" +
  "    - 预警触发时，只说\"以下新闻匹配了你设定的预警条件\"，不说\"你担心的事情发生了\"\n" +
  "    - 查证结果只呈现事实（\"该消息来源为路透社，引述两位匿名官员；公司官方尚未确认\"），不做可靠性判断（不说\"可靠性中等\"、\"基本可信\"）\n\n" +
  "用中文回复。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().optional().describe("只看某只股票（可选，不填则返回全部）"),
    limit: z.number().int().min(1).max(100).default(30).describe("返回条数（默认30）"),
    date: z.string().optional().describe("日期（YYYY-MM-DD），不填则默认今天。用于回溯分析历史日期的已缓存数据。"),
  },
  async ({ token, ticker, limit, date }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    // Expire stale alerts before processing
    expireStaleAlerts(realToken!);

    const today = new Date().toISOString().slice(0, 10);
    const targetDate = date || today;
    const isToday = targetDate === today;

    // For today: use sliding-window cache (existing behavior)
    // For historical dates: use daily date-based cache
    let articles: Article[];
    let focus: string[] | undefined;

    if (isToday) {
      const loaded = loadStockArticles(realToken!, ticker);
      articles = loaded.articles;
      focus = loaded.focus;
    } else {
      articles = loadDailyStockCache(realToken!, ticker, targetDate);
      if (ticker) {
        const wl = getWatchlist(realToken!);
        focus = wl[ticker.toUpperCase()]?.focus;
      }
    }

    if (articles.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            date: targetDate,
            message: isToday
              ? (ticker
                ? `没有找到 ${ticker} 的缓存新闻。请先调用 briefing_stock_fetch 抓取。`
                : "没有找到缓存的股票新闻。请先调用 briefing_stock_fetch 抓取。")
              : `${targetDate} 没有找到缓存的新闻数据。`,
          }),
        }],
      };
    }

    const limited = articles.slice(0, limit);

    // Build focus labels for context
    const focusLabels = focus?.map((id) => {
      const item = FOCUS_CATALOG.find((f) => f.id === id);
      return item ? `${item.label}（${item.description}）` : id;
    });

    // If a specific ticker is requested, include history + divergence + alerts
    let divergence = undefined;
    let historySnapshots = undefined;
    let stockAlerts = undefined;
    let globalAlerts = undefined;
    let expiringAlerts = undefined;
    let noisyAlerts = undefined;

    if (ticker) {
      const upperTicker = ticker.toUpperCase();
      const snapshots = getSnapshots(realToken!, upperTicker, 7);
      if (snapshots.length > 0) {
        historySnapshots = snapshots;
        divergence = detectDivergence(snapshots);
      }

      // Load active alerts for this ticker
      const alerts = getActiveAlertsForTicker(realToken!, upperTicker);
      if (alerts.stock_alerts.length > 0) stockAlerts = alerts.stock_alerts;
      if (alerts.global_alerts.length > 0) globalAlerts = alerts.global_alerts;

      // Near-expiry and noisy alert warnings
      const expiring = getExpiringAlerts(realToken!);
      const tickerExpiring = expiring.filter((e) => e.ticker === upperTicker);
      if (tickerExpiring.length > 0) expiringAlerts = tickerExpiring;

      const noisy = getNoisyAlerts(realToken!);
      const tickerNoisy = noisy.filter((e) => e.ticker === upperTicker);
      if (tickerNoisy.length > 0) noisyAlerts = tickerNoisy;
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: ticker || "all",
          date: targetDate,
          total: articles.length,
          returned: limited.length,
          focus: focus || [],
          focus_labels: focusLabels || [],
          articles: limited,
          stock_alerts: stockAlerts,
          global_alerts: globalAlerts,
          expiring_alerts: expiringAlerts,
          noisy_alerts: noisyAlerts,
          history: historySnapshots,
          divergence,
        }),
      }],
    };
  }
);

// ── Tool: Stock History Record ───────────────────────────────

server.tool(
  "briefing_stock_history_record",
  "记录某只股票的每日情绪快照。在 briefing_stock_digest 分析完成后自动调用。\n" +
  "评分规则：🟢🟢=+2, 🟢=+1, ⚪=0, 🔴=-1, 🔴🔴=-2，sentiment_score = 加权平均值。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe("股票代码，如 AAPL 或 CBA.AX"),
    sentiment_score: z.number().describe("加权平均情绪评分（-2 到 +2）"),
    article_count: z.number().int().describe("本次分析的文章数量"),
    breakdown: z.object({
      strong_bullish: z.number().int(),
      weak_bullish: z.number().int(),
      neutral: z.number().int(),
      weak_bearish: z.number().int(),
      strong_bearish: z.number().int(),
    }).describe("五档情绪分布"),
    key_events: z.array(z.string()).describe("🟢🟢 或 🔴🔴 级别的重大消息摘要"),
    alert_triggers: z.array(z.object({
      alert_id: z.string(),
      description: z.string(),
      headline: z.string(),
    })).optional().describe("本次分析中触发的预警列表"),
    close_price: z.number().optional().describe("当日收盘价（如果 Claude 通过 web search 获取到）"),
    price_change_pct: z.number().optional().describe("当日涨跌幅 %（如果 Claude 通过 web search 获取到）"),
  },
  async ({ token, ticker, sentiment_score, article_count, breakdown, key_events, alert_triggers, close_price, price_change_pct }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const upperTicker = ticker.toUpperCase();
    const today = new Date().toISOString().slice(0, 10);

    // Try to fetch close price from Yahoo if not provided by Claude
    let finalClosePrice = close_price;
    let finalChangePct = price_change_pct;
    let priceSource: string | undefined;

    if (finalClosePrice == null) {
      const yahoo = await fetchClosePrice(upperTicker);
      if (yahoo) {
        finalClosePrice = yahoo.close;
        finalChangePct = yahoo.changePct;
        priceSource = "yahoo";
      }
    } else {
      priceSource = "claude";
    }

    const snapshot: SentimentSnapshot = {
      date: today,
      sentiment_score: Math.round(sentiment_score * 100) / 100,
      sentiment_label: computeSentimentLabel(sentiment_score),
      article_count,
      breakdown: breakdown as SentimentBreakdown,
      key_events,
      alert_triggers: alert_triggers as AlertTriggerRecord[] | undefined,
      close_price: finalClosePrice,
      price_change_pct: finalChangePct,
      price_source: priceSource,
    };

    recordSnapshot(realToken!, upperTicker, snapshot);

    // Note: alert triggers are now recorded via briefing_stock_alert_trigger (with dedup).
    // No need to duplicate that here — history_record only stores the snapshot.

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: upperTicker,
          date: today,
          snapshot,
          message: `${upperTicker} ${today} 情绪快照已记录：${snapshot.sentiment_label}（${snapshot.sentiment_score}）` +
            (finalClosePrice != null ? `，收盘价 ${finalClosePrice}（${finalChangePct! >= 0 ? "+" : ""}${finalChangePct}%）` : ""),
        }),
      }],
    };
  }
);

// ── Tool: Stock History Get ──────────────────────────────────

server.tool(
  "briefing_stock_history_get",
  "查看某只股票的历史情绪趋势。用户说「AAPL 最近一周情况怎么样」「看看苹果的趋势」等时调用。\n" +
  "返回每日情绪评分 + 收盘价 + 涨跌幅，以及背离检测结果。\n\n" +
  "返回的 data_status 标记每天的数据状态：\n" +
  " - complete: 有完整快照，直接使用\n" +
  " - raw_only: 有原始抓取数据但没有快照。先调用 briefing_stock_digest(date=该日期) 做分析，" +
  "再调用 briefing_stock_history_record 写入快照，然后继续\n" +
  " - missing: 什么都没有，标记为数据缺失，在趋势分析中注明\n" +
  "补全完成后，再做整体的趋势分析和背离检测。\n\n" +
  "趋势呈现的语气约束：\n" +
  "- 背离分析只描述现象，不做预测。说\"新闻情绪与股价走势方向不一致\"，不说\"回调风险在累积\"、\"可能即将反转\"\n" +
  "- 列出可能的解释时用\"可能的原因包括：\"，不用\"这说明...\"、\"这意味着...\"\n" +
  "- 不使用\"健康\"、\"危险\"、\"安全\"等暗示投资判断的词\n" +
  "- 不说\"走势良好\"、\"势头强劲\"、\"令人担忧\"，只呈现数据（\"过去 5 天新闻情绪均值 +0.8，股价累计 -2.3%\"）",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().describe("股票代码，如 AAPL 或 CBA.AX"),
    days: z.number().int().min(1).max(90).default(7).describe("查看最近几天（默认7，最大90）"),
  },
  async ({ token, ticker, days }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const upperTicker = ticker.toUpperCase();
    const snapshots = getSnapshots(realToken!, upperTicker, days);

    // Build data_status for each day in the requested range
    const dataStatus: Record<string, "complete" | "raw_only" | "missing"> = {};
    const now = new Date();
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const hasSnapshot = snapshots.some((s) => s.date === dateStr);
      const hasRawCache = hasDailyStockCache(realToken!, upperTicker, dateStr);
      dataStatus[dateStr] = hasSnapshot ? "complete" : hasRawCache ? "raw_only" : "missing";
    }

    if (snapshots.length === 0) {
      // Still return data_status so Claude knows if raw data exists for backfill
      const hasAnyRaw = Object.values(dataStatus).some((s) => s === "raw_only");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            ticker: upperTicker,
            data_status: dataStatus,
            message: hasAnyRaw
              ? `${upperTicker} 还没有情绪快照，但有原始抓取数据可以补做分析。请按 data_status 中 raw_only 的日期逐天调用 briefing_stock_digest(date=该日期) 补全。`
              : `${upperTicker} 还没有历史情绪数据。每次使用 briefing_stock_digest 分析后会自动记录。`,
          }),
        }],
      };
    }

    const divergence = detectDivergence(snapshots);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: upperTicker,
          days_requested: days,
          days_available: snapshots.length,
          data_status: dataStatus,
          snapshots,
          divergence,
          instructions: divergence.detected
            ? "检测到情绪与股价背离，请分析可能原因并作为单独板块呈现给用户。"
            : undefined,
        }),
      }],
    };
  }
);

// ── Tool: Stock Alert Set ────────────────────────────────────

server.tool(
  "briefing_stock_alert_set",
  "批量创建预警。用户贴入分析师报告后由 Claude 提取关注点并调用此工具。\n" +
  "也可手动创建：「帮我设一个 AAPL 的预警，关注造车项目是否取消」。\n" +
  "每只股票最多 10 条活跃预警。不传 ticker 则创建通用预警（跨股票/宏观事件）。\n\n" +
  "如果用户提供了分析师报告，请先提取关注点，呈现给用户确认后再调用此工具。\n\n" +
  "呈现提取结果时使用中性描述：\n" +
  "- 不说\"报告认为风险很大\"、\"分析师非常担忧\"，说\"报告提到了以下关注点\"\n" +
  "- rationale 字段只描述为什么从报告中提取了这条（\"报告指出 Q3 前会有明确决定\"），不加入自己的判断（不说\"这个风险确实值得重视\"）",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().optional().describe("股票代码。不填则创建通用预警。"),
    alerts: z.array(z.object({
      description: z.string().describe("自然语言描述的监控条件"),
      keywords: z.array(z.string()).describe("辅助关键词（3-8个，用于初筛）"),
      expires_in_months: z.number().optional().describe("监控几个月（默认6）"),
      sensitivity: z.enum(["loose", "normal", "strict"]).optional().describe("匹配松紧度（默认normal）"),
      source_report: z.string().optional().describe("预警来源标记（如 'Morgan Stanley 2026-03'）"),
    })).describe("要创建的预警列表"),
    scope: z.object({
      markets: z.array(z.string()).optional(),
      sectors: z.array(z.string()).optional(),
      tickers: z.array(z.string()).optional(),
    }).optional().describe("通用预警的影响范围（仅不传 ticker 时使用）"),
  },
  async ({ token, ticker, alerts: alertInputs, scope }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    // Global alert
    if (!ticker) {
      const inputs: GlobalAlertInput[] = alertInputs.map((a) => ({
        ...a,
        scope: {
          markets: scope?.markets ?? [],
          sectors: scope?.sectors ?? [],
          tickers: scope?.tickers ?? [],
        },
      }));
      const created = setGlobalAlerts(realToken!, inputs);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "success",
            type: "global",
            created: created.length,
            alerts: created,
            message: `已创建 ${created.length} 条通用预警。`,
          }),
        }],
      };
    }

    // Per-ticker alert
    const upperTicker = ticker.toUpperCase();
    const { alerts: created, error: alertError } = setAlerts(realToken!, upperTicker, alertInputs as AlertInput[]);
    if (alertError) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "error", ticker: upperTicker, message: alertError }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          type: "stock",
          ticker: upperTicker,
          created: created.length,
          alerts: created,
          message: `已为 ${upperTicker} 创建 ${created.length} 条预警。`,
        }),
      }],
    };
  }
);

// ── Tool: Stock Alert List ──────────────────────────────────

server.tool(
  "briefing_stock_alert_list",
  "查看预警列表。用户说「我设了哪些预警」「AAPL 的预警」等时调用。\n" +
  "返回每条预警的状态、触发次数、剩余时间。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().optional().describe("只看某只股票的预警（不填则返回全部）"),
    status: z.enum(["active", "all"]).default("active").describe("状态过滤：active=仅活跃/已触发，all=含过期和已关闭"),
  },
  async ({ token, ticker, status }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    expireStaleAlerts(realToken!);
    const upperTicker = ticker?.toUpperCase();
    const { ticker_alerts, global_alerts } = listAlerts(realToken!, upperTicker, status as "active" | "all");

    const tickerCount = Object.values(ticker_alerts).reduce((sum, arr) => sum + arr.length, 0);
    const totalCount = tickerCount + global_alerts.length;

    if (totalCount === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            message: "没有预警。可以用 briefing_stock_alert_set 创建，或者贴入分析师报告让我帮你提取关注点。",
          }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          total: totalCount,
          ticker_alerts,
          global_alerts,
        }),
      }],
    };
  }
);

// ── Tool: Stock Alert Update ────────────────────────────────

server.tool(
  "briefing_stock_alert_update",
  "修改预警的松紧度、时间窗口、描述、关键词。\n" +
  "用户说「那条预警改成 strict」「延长 3 个月」「加个关键词」等时调用。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    alert_id: z.string().describe("预警ID，如 alert_aapl_001 或 galert_001"),
    sensitivity: z.enum(["loose", "normal", "strict"]).optional().describe("修改匹配松紧度"),
    extend_months: z.number().optional().describe("延长过期时间（月数）"),
    add_keywords: z.array(z.string()).optional().describe("添加关键词"),
    remove_keywords: z.array(z.string()).optional().describe("移除关键词"),
    description: z.string().optional().describe("替换描述"),
    status: z.enum(["dismissed"]).optional().describe("手动关闭"),
  },
  async ({ token, alert_id, sensitivity, extend_months, add_keywords, remove_keywords, description, status }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const updated = updateAlert(realToken!, alert_id, {
      sensitivity: sensitivity as any,
      extend_months,
      add_keywords,
      remove_keywords,
      description,
      status: status as any,
    });

    if (!updated) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "not_found", alert_id, message: `未找到预警 ${alert_id}。` }),
        }],
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          alert: updated,
          message: `预警 ${alert_id} 已更新。`,
        }),
      }],
    };
  }
);

// ── Tool: Stock Alert Dismiss ───────────────────────────────

server.tool(
  "briefing_stock_alert_dismiss",
  "关闭一条或多条预警。用户说「第 3 条关了吧」「关掉那个预警」等时调用。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    alert_ids: z.array(z.string()).describe("要关闭的预警ID列表"),
  },
  async ({ token, alert_ids }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const dismissed = dismissAlerts(realToken!, alert_ids);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          dismissed,
          message: dismissed.length > 0
            ? `已关闭 ${dismissed.length} 条预警：${dismissed.join("、")}。`
            : "没有找到需要关闭的预警。",
        }),
      }],
    };
  }
);

// ── Tool: Stock Alert Trigger ───────────────────────────────

server.tool(
  "briefing_stock_alert_trigger",
  "记录预警触发 + 事件级去重。在 briefing_stock_digest 分析过程中发现新闻命中 alert 时调用。\n\n" +
  "流程：\n" +
  "1. 从新闻中提取事件日期（event_date，事件本身发生的日期，非新闻发布日期）和事件摘要（summary）\n" +
  "2. 调用此工具，server 会检查 trigger_history 中是否有日期相近（±3天）的已触发记录\n" +
  "3. 如果返回 near_date_found + near_entries：\n" +
  "   - 比对新闻内容与已有 event_signature\n" +
  "   - 语义相同（同一事件重复报道）→ 再次调用此工具，action='append_duplicate'\n" +
  "   - 有实质性进展（传闻→官方确认等）→ 再次调用此工具，action='confirm'，is_update=true\n" +
  "   - 不同事件 → 再次调用此工具，action='confirm'，is_update=false\n" +
  "4. 如果返回 new_trigger → 已自动记录，无需额外操作\n\n" +
  "触发通知的语气：\n" +
  "- 说\"你设定的预警条件匹配到了以下新闻\"，不说\"你担心的事情出现了新进展\"\n" +
  "- 说\"以下是相关来源的信息\"，不说\"经查证，该消息基本属实\"\n" +
  "- 事件更新用 ⚠️🔄 标注，附上\"此前已有相关预警，本次为事件进展\"",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    alert_ids: z.array(z.string()).describe("被触发的预警ID列表"),
    event_signature: z.object({
      event_date: z.string().describe("事件本身的日期，ISO 格式（如 \"2026-03-25\"）"),
      summary: z.string().describe("一句话事件摘要"),
    }).optional().describe("事件签名，用于去重。首次调用时必填。"),
    source_url: z.string().default("").describe("触发来源文章 URL"),
    is_update: z.boolean().default(false).describe("是否为已有事件的实质性进展（默认 false）"),
    action: z.enum(["check", "confirm", "append_duplicate"]).default("check")
      .describe("check=首次检查去重（默认），confirm=Claude确认为新事件后写入，append_duplicate=追加重复来源"),
  },
  async ({ token, alert_ids, event_signature, source_url, is_update, action }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const results: unknown[] = [];

    for (const id of alert_ids) {
      if (action === "append_duplicate") {
        if (event_signature) {
          appendDuplicateSource(realToken!, id, event_signature.event_date, event_signature.summary, source_url);
          results.push({ alert_id: id, action: "duplicate_appended" });
        }
      } else if (action === "confirm") {
        if (event_signature) {
          confirmAlertTrigger(realToken!, id, event_signature, source_url, is_update);
          results.push({ alert_id: id, action: "confirmed", is_update });
        }
      } else {
        // action === "check" (default)
        if (event_signature) {
          const result = recordAlertTrigger(realToken!, id, event_signature, source_url, is_update);
          results.push(result);
        } else {
          // Backwards compat: no event_signature → legacy simple trigger
          const result = recordAlertTrigger(
            realToken!, id,
            { event_date: new Date().toISOString().slice(0, 10), summary: "（未提供事件签名）" },
            source_url,
            false,
          );
          results.push(result);
        }
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          results,
          message: `已处理 ${alert_ids.length} 条预警。`,
        }),
      }],
    };
  }
);

// ── MCP Prompts ──────────────────────────────────────────────

server.prompt(
  "getting-started",
  "第一次用？从这里开始——注册、设置偏好、选择信源，3分钟搞定",
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "我想开始用新闻简报功能。请帮我：\n\n" +
            "1. 先注册一下\n" +
            "2. 通过问答了解我关注什么、不想看什么\n" +
            "3. 推荐适合我的新闻来源\n\n" +
            "一步步来就好。",
        },
      },
    ],
  })
);

server.prompt("setup-profile", "重新设置你关注的内容和过滤偏好", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "我想重新设置我的新闻偏好。\n" +
          "问我几个问题了解我现在关注什么、在做什么项目、不想看什么内容，然后帮我更新。",
      },
    },
  ],
}));

server.prompt("daily-briefing", "看看今天有什么值得关注的（含股票动态）", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "看看今天有什么值得关注的新闻。\n\n" +
          "流程：\n" +
          "1. 先抓取新闻（briefing_fetch_articles），根据兴趣偏好筛选呈现\n" +
          "2. 如果我有关注的股票（briefing_stock_watchlist_get 检查），\n" +
          "   接着抓取股票新闻（briefing_stock_fetch）并分析（briefing_stock_digest），\n" +
          "   在新闻简报后追加「📊 关注股票动态」板块\n" +
          "3. 如果没有 watchlist 则跳过股票部分",
      },
    },
  ],
}));

server.prompt("stock-briefing", "只看关注股票的最新动态", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "看看我关注的股票有什么新消息。",
      },
    },
  ],
}));

// ── Startup auto-fetch ──────────────────────────────────────

async function runStartupAutoFetch(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const tokens = getAllTokens();

  for (const token of tokens) {
    try {
      const settings = getUserSettings(token);
      if (!settings.auto_fetch_enabled) continue;

      const wl = getWatchlist(token);
      if (Object.keys(wl).length === 0) continue;

      // Idempotent: skip if already fetched today
      if (settings.last_stock_fetch === today) {
        log(`⏭️  Auto-fetch: already done today for ${token.slice(0, 8)}...`);
        continue;
      }

      log(`🤖 Auto-fetch: starting for ${token.slice(0, 8)}... (${Object.keys(wl).length} tickers)`);
      await fetchStockNews(token, 24);
      setUserSettings(token, { last_stock_fetch: today });
      log(`✅ Auto-fetch: completed for ${token.slice(0, 8)}...`);
    } catch (e) {
      log(`⚠️  Auto-fetch failed for ${token.slice(0, 8)}...: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ── Start ────────────────────────────────────────────────────

async function main() {
  log("🌅 AI Briefing MCP Server (TypeScript) starting...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("✅ Server connected via stdio");

  // Run auto-fetch in background (non-blocking, after MCP handshake)
  runStartupAutoFetch().catch((e) => {
    log(`⚠️  Auto-fetch error: ${e instanceof Error ? e.message : e}`);
  });
}

main().catch((err) => {
  log(`❌ Fatal: ${err}`);
  process.exit(1);
});
