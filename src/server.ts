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

import { registerUser, resolveToken, verifyToken } from "./auth.js";
import { getProfile, setProfile, getProfilePrompt, PROFILE_QUESTIONNAIRE, suggestSources } from "./profile.js";
import { getSources, setSourcesFromCategories, addCustomSources } from "./user-sources.js";
import { fetchAll, loadTodayArticles, loadArticlesByDate, type Article } from "./sources.js";
import { logInteraction, getInteractionSummary, getFullLog } from "./interaction-log.js";
import { log } from "./storage.js";

// ── Token validation helper ──────────────────────────────────

function requireToken(token: string): { error?: string; realToken?: string } {
  if (!token?.trim()) {
    return {
      error: JSON.stringify({
        status: "error",
        error: "missing_token",
        message: "需要提供token或用户名。如果还没有注册，请先用 briefing_register 注册。",
      }),
    };
  }

  const realToken = resolveToken(token.trim());
  if (!realToken) {
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
  "注册新闻简报服务。用户说"帮我注册"、"我想开始用简报"等时调用。\n返回一个token，后续可以用token或用户名识别身份。",
  { name: z.string().default("").describe("用户名称（可选）") },
  async ({ name }) => {
    const result = registerUser(name);

    const message = result.is_new
      ? `🎉 注册成功！\n\n**用户名：** ${result.name}\n**Token：** ${result.token}\n\n⚠️ 请保存此token，后续也可以用名字来识别。\n\n下一步：可以设置你的兴趣偏好，让简报更精准。`
      : `用户 ${result.name} 已存在，无需重复注册。\nToken：${result.token}\n\n可以直接说"看看今天的新闻"开始使用。`;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ status: "success", token: result.token, name: result.name, is_new: result.is_new, message }),
        },
      ],
    };
  }
);

// ── Tool: Set Profile ────────────────────────────────────────

server.tool(
  "briefing_set_profile",
  "设置或更新用户的兴趣偏好。用户说"我想关注XX"、"帮我加个兴趣"、"不想再看XX"等时调用。\n只传需要更新的字段，其他保持不变。兴趣偏好是新闻过滤的核心依据。",
  {
    token: z.string().describe("用户token或用户名"),
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
  "通过问答了解用户的兴趣偏好。用户说"帮我设置偏好"、"重新设置我关注的内容"等时调用。\n返回引导问题，收集完毕后整理成JSON调用 briefing_set_profile 提交。",
  { token: z.string().describe("用户token或用户名") },
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
  "根据用户的兴趣偏好推荐新闻来源（RSS、Reddit、Hacker News）。\n用户说"帮我推荐信源"、"有什么好的订阅推荐"等时调用。",
  { token: z.string().describe("用户token或用户名") },
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
    token: z.string().describe("用户token或用户名"),
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
  "添加自定义新闻来源（追加，不会覆盖已有的）。\n用户说"帮我加一个RSS"、"我还想看XX的Reddit"等时调用。",
  {
    token: z.string().describe("用户token或用户名"),
    rss: z.record(z.string()).optional().describe('自定义RSS源，格式 {"名称": "URL"}，如 {"my-blog": "https://example.com/feed.xml"}'),
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
  "查看当前订阅了哪些新闻来源。用户说"我现在订阅了什么"、"看看我的信源"等时调用。",
  { token: z.string().describe("用户token或用户名") },
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
  "从订阅的新闻来源抓取最新内容。用户说"看看今天的新闻"、"最近有什么值得看的"、"这周的简报"等时，先调用此工具获取数据。\n\n时间范围：24=今天，168=本周，720=本月。",
  {
    token: z.string().describe("用户token或用户名"),
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
    token: z.string().describe("用户token或用户名"),
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
  { token: z.string().describe("用户token或用户名") },
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
              "2. 实际发布/发生日期（注意区分'事件发生日期'和'被讨论日期'，" +
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
    token: z.string().describe("用户token或用户名"),
    action: z.string().describe("行为类型：'read_detail'=展开阅读，'discussed'=深入讨论，'saved'=收藏，'feedback'=反馈"),
    article_title: z.string().default("").describe("相关文章标题"),
    article_url: z.string().default("").describe("相关文章链接"),
    topics: z.array(z.string()).default([]).describe("相关话题标签，如['MCP', 'Edge AI']"),
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
  "分析用户最近的阅读兴趣趋势。用户说"我最近关注了什么"、"这周看了些啥"等时调用。",
  {
    token: z.string().describe("用户token或用户名"),
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
    token: z.string().describe("用户token或用户名"),
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

server.prompt("daily-briefing", "看看今天有什么值得关注的", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: "看看今天有什么值得关注的新闻。",
      },
    },
  },
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
