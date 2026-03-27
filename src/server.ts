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

import { registerUser, resolveToken, verifyToken, setDefault, getDefaultName } from "./auth.js";
import { getProfile, setProfile, getProfilePrompt, PROFILE_QUESTIONNAIRE, suggestSources } from "./profile.js";
import { getSources, setSourcesFromCategories, addCustomSources } from "./user-sources.js";
import { fetchAll, loadTodayArticles, loadArticlesByDate, type Article } from "./sources.js";
import { logInteraction, getInteractionSummary, getFullLog } from "./interaction-log.js";
import { log } from "./storage.js";
import { getWatchlist, setWatchlistEntry, removeWatchlistEntry, updateFocus, FOCUS_CATALOG, type Market } from "./watchlist.js";
import { fetchStockNews, loadStockArticles } from "./stock-sources.js";

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
  "briefing_watchlist_set",
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
            : "以上是根据 market + sector 自动推荐的侧重面，请告知用户并询问是否需要调整。如需调整，调用 briefing_watchlist_update_focus。",
        }),
      }],
    };
  }
);

// ── Tool: Watchlist Get ──────────────────────────────────────

server.tool(
  "briefing_watchlist_get",
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
            message: "还没有关注任何股票。用 briefing_watchlist_set 添加。",
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
  "briefing_watchlist_remove",
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
  "briefing_watchlist_update_focus",
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
            message: `未找到 ${ticker.toUpperCase()}，请先用 briefing_watchlist_set 添加。`,
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
            message: "还没有关注任何股票。请先用 briefing_watchlist_set 添加。",
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
  "获取已抓取的股票新闻列表，供分析利好/利空。拿到数据后请：\n" +
  "1. 根据该股票的侧重面（focus）逐条分析\n" +
  "2. 每条新闻标注：🟢🟢 强利好 | 🟢 弱利好 | ⚪ 中性 | 🔴 弱利空 | 🔴🔴 强利空\n" +
  "3. 跟侧重面无关但重大的消息也要标注\n" +
  "4. 对🟢🟢和🔴🔴级别的消息，用 web search 查证官方来源\n" +
  "5. 最后给一句整体情绪总结\n\n" +
  "用中文回复。",
  {
    token: z.string().default("").describe("用户token或用户名。留空则自动使用默认身份。"),
    ticker: z.string().optional().describe("只看某只股票（可选，不填则返回全部）"),
    limit: z.number().int().min(1).max(100).default(30).describe("返回条数（默认30）"),
  },
  async ({ token, ticker, limit }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const { articles, focus } = loadStockArticles(realToken!, ticker);

    if (articles.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "empty",
            message: ticker
              ? `没有找到 ${ticker} 的缓存新闻。请先调用 briefing_stock_fetch 抓取。`
              : "没有找到缓存的股票新闻。请先调用 briefing_stock_fetch 抓取。",
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

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "success",
          ticker: ticker || "all",
          total: articles.length,
          returned: limited.length,
          focus: focus || [],
          focus_labels: focusLabels || [],
          articles: limited,
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
          "2. 如果我有关注的股票（briefing_watchlist_get 检查），\n" +
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

// ── Start ────────────────────────────────────────────────────

async function main() {
  log("🌅 AI Briefing MCP Server (TypeScript) starting...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("✅ Server connected via stdio");
}

main().catch((err) => {
  log(`❌ Fatal: ${err}`);
  process.exit(1);
});
