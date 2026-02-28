#!/usr/bin/env node
/**
 * 🌅 AI Briefing — MCP Server (TypeScript)
 *
 * Personalized AI & tech news filtering via MCP tools.
 * Designed for zero-dependency installation via .mcpb Desktop Extension.
 *
 * Usage:
 *   npx briefing-mcp          # stdio mode (Claude Desktop)
 *   npx briefing-mcp --http   # HTTP mode (remote)
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
        message: "需要提供token或用户名。如果还没有注册，请先调用 briefing_register。",
      }),
    };
  }

  const realToken = resolveToken(token.trim());
  if (!realToken) {
    return {
      error: JSON.stringify({
        status: "error",
        error: "invalid_token",
        message: "找不到匹配的用户。可以传入token或注册时的用户名。\n如果还没有注册，请先调用 briefing_register。",
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
  name: "briefing-mcp",
  version: "0.1.0",
});

// ── Tool: Register ───────────────────────────────────────────

server.tool(
  "briefing_register",
  "注册新用户并获取一个token。\n这个token用于所有后续操作,请妥善保存。",
  { name: z.string().default("").describe("用户名称(可选,方便辨识)") },
  async ({ name }) => {
    const result = registerUser(name);

    const message = result.is_new
      ? `🎉 注册成功！\n\n**用户名：** ${result.name}\n**Token：** ${result.token}\n\n⚠️ 请保存此token。后续操作可以用token或用户名来识别身份。\n\n下一步：调用 briefing_create_profile_interactive 开始画像设置问卷。`
      : `用户 ${result.name} 已存在，无需重复注册。\nToken：${result.token}\n\n可以直接开始使用，或调用 briefing_set_profile 更新画像。`;

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
  "设置或更新用户画像。只需传入要更新的字段,未传入的保持不变。\n画像是信息过滤的核心——Claude会根据画像来评估每条内容的匹配度。",
  {
    token: z.string().describe("用户token"),
    profile: z
      .object({
        name: z.string().optional(),
        strengths: z.array(z.string()).optional(),
        active_projects: z.array(z.string()).optional(),
        high_interest: z.array(z.string()).optional(),
        exploration_interest: z.array(z.string()).optional(),
        noise_filter: z.array(z.string()).optional(),
      })
      .describe("用户画像JSON,可包含以下字段(只传需要更新的):\n- name: 名称\n- strengths: 核心特质列表\n- active_projects: 当前项目列表\n- high_interest: 高度关注领域列表\n- exploration_interest: 探索性关注列表\n- noise_filter: 噪音过滤规则列表"),
  },
  async ({ token, profile }) => {
    const { error, realToken } = requireToken(token);
    if (error) return { content: [{ type: "text" as const, text: error }] };

    const updated = setProfile(realToken!, profile);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "success", profile: updated, message: "画像已更新。" }) }],
    };
  }
);

// ── Tool: Profile Questionnaire ──────────────────────────────

server.tool(
  "briefing_create_profile_interactive",
  "获取画像引导问卷。返回一系列问题供AI与用户对话收集信息。\n收集完成后,AI应将回答整理成画像JSON,调用 briefing_set_profile 提交。\n\n适用场景:新用户首次设置画像,或用户想重新设置画像时。",
  { token: z.string().describe("用户token或注册时的用户名") },
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
  "根据用户画像推荐相关信源(RSS、Reddit、HN关键词)。\n返回匹配的信源分类列表,用户确认后调用 briefing_set_sources 订阅。",
  { token: z.string().describe("用户token或注册时的用户名") },
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
  "根据选择的分类ID设置用户的信源订阅。\n这会更新用户的RSS、Reddit、HN关键词配置。\n用户之前添加的自定义信源会保留。",
  {
    token: z.string().describe("用户token"),
    category_ids: z
      .array(z.string())
      .describe("选择的信源分类ID列表,如 ['anthropic', 'embedded', 'ai_general']。分类ID来自 briefing_suggest_sources 的返回结果。"),
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
  "添加自定义信源(追加,不覆盖已有的)。\n可以添加自定义RSS、Reddit板块、HN关键词。",
  {
    token: z.string().describe("用户token"),
    rss: z.record(z.string()).optional().describe('自定义RSS源,格式 {"名称": "URL"},如 {"my-blog": "https://example.com/feed.xml"}'),
    reddit: z.array(z.string()).optional().describe('Reddit板块名称列表,如 ["python", "golang"]'),
    hn_keywords: z.array(z.string()).optional().describe('HN过滤关键词列表,如 ["kubernetes", "docker"]'),
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
  "查看用户当前的信源配置,包括订阅的分类和自定义信源。",
  { token: z.string().describe("用户token或注册时的用户名") },
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
  "从RSS、Reddit、Hacker News抓取最新的AI和技术相关文章。\n抓取的文章会保存在本地,供后续过滤和分析使用。\n每天首次查看简报时应先调用此工具获取最新数据。\n\n时间范围通过hours_back控制:24=今天,168=本周,720=本月。",
  {
    token: z.string().describe("用户token或注册时的用户名"),
    hours_back: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24)
      .describe("回溯多少小时的内容。常用值:\n- 24 = 今天(默认)\n- 48 = 最近两天\n- 168 = 本周\n- 720 = 本月"),
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
            message: `已获取${articles.length}条内容。请使用 briefing_get_articles 查看文章列表，然后根据用户画像进行过滤分析。`,
          }),
        },
      ],
    };
  }
);

// ── Tool: Get Articles ───────────────────────────────────────

server.tool(
  "briefing_get_articles",
  "获取已抓取并保存在本地的文章列表。\n返回文章标题、来源、摘要等信息,供Claude根据用户画像进行过滤分析。",
  {
    token: z.string().describe("用户token或注册时的用户名"),
    date: z.string().optional().describe("日期(YYYY-MM-DD格式),默认为今天"),
    limit: z.number().int().min(1).max(200).default(8).describe("最多返回多少条(默认8条,适合日常浏览;需要更多可调大)"),
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
              message: `${dateStr} 没有已保存的文章。请先调用 briefing_fetch_articles 抓取。`,
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
  "获取用户的特质画像,包含关注领域、当前项目、噪音过滤规则等。\nClaude应在分析文章前先读取此画像,作为过滤和匹配的依据。",
  { token: z.string().describe("用户token或注册时的用户名") },
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
              "请根据此画像对文章进行匹配评估。" +
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
  "记录用户与简报的互动行为。\n当用户要求展开某条文章、深入讨论某个话题、或标记收藏时,\nClaude应自动调用此工具记录,用于后续的兴趣模式分析。",
  {
    token: z.string().describe("用户token"),
    action: z.string().describe("互动类型: 'read_detail'=展开阅读, 'discussed'=深入讨论, 'saved'=标记收藏, 'feedback'=过滤反馈"),
    article_title: z.string().default("").describe("相关文章标题"),
    article_url: z.string().default("").describe("相关文章链接"),
    topics: z.array(z.string()).default([]).describe("相关话题标签,如['MCP', 'Edge AI', 'ESP32']"),
    notes: z.string().default("").describe("备注信息"),
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
  "生成用户最近的互动摘要。",
  {
    token: z.string().describe("用户token"),
    days: z.number().int().min(1).max(90).default(7).describe("回顾最近多少天的互动(默认7天)"),
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
              "请用中文自然地呈现这个摘要，帮用户看到自己的兴趣模式。" +
              "如果有明显的话题偏好趋势，指出来。" +
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
  "查看最近的互动日志原始记录。",
  {
    token: z.string().describe("用户token"),
    limit: z.number().int().min(1).max(100).default(20).describe("最多返回多少条记录"),
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
  "首次使用？从这里开始 — 注册、建画像、选信源，3分钟搞定",
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            "你好！欢迎使用 AI简报系统。我来帮你完成初始设置：\n\n" +
            "**第1步：注册**\n请调用 briefing_register 为用户注册，获取一个token。\n\n" +
            "**第2步：建画像**\n调用 briefing_create_profile_interactive 获取引导问卷，" +
            "然后跟用户对话收集信息，整理后调用 briefing_set_profile 提交。\n\n" +
            "**第3步：选信源**\n调用 briefing_suggest_sources 获取推荐，" +
            "用户确认后调用 briefing_set_sources 订阅。\n\n" +
            "**完成！** 之后用户说'看看今天的简报'就可以使用了。\n\n" +
            "现在开始第1步，问用户想用什么名字注册。",
        },
      },
    ],
  })
);

server.prompt("setup-profile", "重新设置或调整你的兴趣画像", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "用户想设置或重新设置画像。\n\n" +
          "请调用 briefing_create_profile_interactive 获取引导问卷，" +
          "然后跟用户自然对话收集信息。\n" +
          "收集完成后整理成画像JSON，调用 briefing_set_profile 提交。\n" +
          "提交后建议调用 briefing_suggest_sources 帮用户更新信源。",
      },
    },
  ],
}));

server.prompt("daily-briefing", "查看今天的个性化AI简报", async () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text:
          "用户想看今天的简报。请按以下顺序操作：\n\n" +
          "1. 调用 briefing_get_profile 获取用户画像\n" +
          "2. 调用 briefing_fetch_articles 抓取最新文章\n" +
          "3. 调用 briefing_get_articles 获取文章列表\n" +
          "4. 根据画像分析每条文章的匹配度\n" +
          "5. 分为🔴高度匹配、🟡中等匹配、⚪低优先级、🚫已过滤，呈现给用户\n\n" +
          "对🔴高度匹配中的重大消息，用web search查证官方来源。用中文回复。",
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
