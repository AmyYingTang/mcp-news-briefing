/**
 * Profile management — user interest preferences, questionnaire, source recommendations
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";

// ── Types ───────────────────────────────────────────────────

export interface UserProfile {
  name: string;
  strengths: string[];
  active_projects: string[];
  high_interest: string[];
  exploration_interest: string[];
  noise_filter: string[];
}

const DEFAULT_PROFILE: UserProfile = {
  name: "",
  strengths: [],
  active_projects: [],
  high_interest: [],
  exploration_interest: [],
  noise_filter: [],
};

// ── CRUD ────────────────────────────────────────────────────

export function getProfile(token: string): UserProfile {
  const dir = getUserDataDir(token);
  return readJSON<UserProfile>(join(dir, "profile.json"), { ...DEFAULT_PROFILE });
}

export function setProfile(token: string, partial: Partial<UserProfile>): UserProfile {
  const current = getProfile(token);
  const updated = { ...current, ...partial };
  const dir = getUserDataDir(token);
  writeJSON(join(dir, "profile.json"), updated);
  return updated;
}

// ── Profile questionnaire ────────────────────────────────────

export const PROFILE_QUESTIONNAIRE = {
  instructions:
    "请根据以下问题与用户对话，收集信息后整理成兴趣偏好JSON，" +
    "调用 briefing_set_profile 提交。\n" +
    "不需要逐字逐条问，自然对话即可，根据用户回答灵活追问。\n" +
    "用户可以跳过任何问题。",
  questions: [
    {
      field: "name",
      ask: "你想用什么名字？（方便辨识）",
    },
    {
      field: "strengths",
      ask: "你的职业背景是什么？有哪些核心特长？\n比如：软件工程、嵌入式开发、数据分析、产品设计……",
      examples: ["10年以上软件工程经验，擅长系统架构", "全栈开发，偏前端", "数据科学背景，关注MLOps"],
    },
    {
      field: "active_projects",
      ask: "现在手上在做什么项目或者关注什么事情？\n可以是工作项目，也可以是个人的。",
      examples: ["在做一个MCP Server项目", "ESP32物联网传感器", "准备一个技术博客"],
    },
    {
      field: "high_interest",
      ask: "你最关注哪些领域的消息？这些是你每天都想看到的。\n不限于技术——天文、金融、健康，都可以。",
      examples: ["MCP协议和工具生态", "嵌入式AI/TinyML", "Anthropic和Claude的更新", "天文观测"],
    },
    {
      field: "exploration_interest",
      ask: "有没有一些你想了解但不是核心关注的领域？\n这些内容每周看到几条就够了。",
      examples: ["量子计算进展", "Rust语言生态", "太空探索", "独立游戏开发"],
    },
    {
      field: "noise_filter",
      ask: "有什么内容你明确不想看到的？\n直接过滤掉，不出现在简报里。",
      examples: ["纯融资/估值新闻", "加密货币炒作", "大厂裁员八卦", "标题党内容"],
    },
  ],
};

// ── Source catalog ───────────────────────────────────────────

interface SourceCategory {
  label: string;
  keywords: string[];
  rss: Record<string, string>;
  reddit: string[];
  hn_keywords: string[];
}

const SOURCE_CATALOG: Record<string, SourceCategory> = {
  anthropic: {
    label: "Anthropic / Claude",
    keywords: ["anthropic", "claude", "mcp", "model context protocol"],
    rss: {
      "anthropic-blog": "https://www.anthropic.com/blog/rss.xml",
      "anthropic-news": "https://www.anthropic.com/news/rss.xml",
      "anthropic-research": "https://www.anthropic.com/research/rss.xml",
    },
    reddit: ["ClaudeAI", "AnthropicAI"],
    hn_keywords: ["anthropic", "claude", "mcp"],
  },
  ai_general: {
    label: "AI General / LLM",
    keywords: ["ai", "llm", "gpt", "openai", "gemini", "machine learning", "deep learning", "transformer"],
    rss: {
      "openai-blog": "https://openai.com/blog/rss.xml",
      "deepmind-blog": "https://deepmind.google/blog/rss.xml",
      "hf-blog": "https://huggingface.co/blog/feed.xml",
    },
    reddit: ["MachineLearning", "LocalLLaMA", "artificial"],
    hn_keywords: ["llm", "gpt", "openai", "gemini", "transformer", "machine learning"],
  },
  ai_agents: {
    label: "AI Agents / Tooling",
    keywords: ["agent", "tool use", "function calling", "agentic", "langchain", "autogen", "crew"],
    rss: {
      "langchain-blog": "https://blog.langchain.dev/rss/",
    },
    reddit: ["LangChain"],
    hn_keywords: ["ai agent", "function calling", "langchain", "autogen"],
  },
  embedded: {
    label: "Embedded / IoT / Edge AI",
    keywords: ["embedded", "esp32", "arduino", "iot", "edge ai", "tinyml", "raspberry pi", "microcontroller"],
    rss: {
      "hackaday": "https://hackaday.com/feed/",
      "adafruit": "https://blog.adafruit.com/feed/",
    },
    reddit: ["esp32", "embedded", "arduino", "IOT"],
    hn_keywords: ["esp32", "embedded", "tinyml", "edge ai", "raspberry pi"],
  },
  dev_tools: {
    label: "Developer Tools / DevOps",
    keywords: ["devops", "kubernetes", "docker", "ci/cd", "github", "vscode", "developer tools", "infrastructure"],
    rss: {
      "github-blog": "https://github.blog/feed/",
    },
    reddit: ["devops", "kubernetes", "docker"],
    hn_keywords: ["kubernetes", "docker", "github", "devops"],
  },
  security: {
    label: "Security / Privacy",
    keywords: ["security", "cybersecurity", "privacy", "vulnerability", "encryption", "zero trust"],
    rss: {
      "krebs": "https://krebsonsecurity.com/feed/",
      "schneier": "https://www.schneier.com/feed/atom/",
    },
    reddit: ["netsec", "cybersecurity"],
    hn_keywords: ["security", "vulnerability", "encryption", "zero-day"],
  },
  web_dev: {
    label: "Web Development",
    keywords: ["react", "vue", "svelte", "nextjs", "typescript", "javascript", "frontend", "web dev", "css"],
    rss: {
      "css-tricks": "https://css-tricks.com/feed/",
    },
    reddit: ["reactjs", "webdev", "typescript", "javascript"],
    hn_keywords: ["react", "nextjs", "typescript", "frontend"],
  },
  python: {
    label: "Python Ecosystem",
    keywords: ["python", "fastapi", "django", "flask", "pandas", "numpy", "pip", "poetry"],
    rss: {
      "real-python": "https://realpython.com/atom.xml",
      "python-insider": "https://blog.python.org/feeds/posts/default",
    },
    reddit: ["Python", "learnpython"],
    hn_keywords: ["python", "fastapi", "django"],
  },
  rust: {
    label: "Rust Language",
    keywords: ["rust", "cargo", "tokio", "wasm", "webassembly"],
    rss: {
      "rust-blog": "https://blog.rust-lang.org/feed.xml",
      "this-week-in-rust": "https://this-week-in-rust.org/atom.xml",
    },
    reddit: ["rust"],
    hn_keywords: ["rust", "cargo", "tokio"],
  },
  astronomy: {
    label: "Astronomy / Space",
    keywords: ["astronomy", "telescope", "space", "nasa", "astrophotography", "starlink", "rocket", "aerospace"],
    rss: {
      "nasa-breaking": "https://www.nasa.gov/news-release/feed/",
      "space-com": "https://www.space.com/feeds/all",
    },
    reddit: ["astrophotography", "astronomy", "space", "spacex"],
    hn_keywords: ["nasa", "spacex", "telescope", "astronomy"],
  },
  science: {
    label: "Science General",
    keywords: ["science", "physics", "biology", "chemistry", "research", "nature", "paper"],
    rss: {
      "nature-news": "https://www.nature.com/nature.rss",
      "arxiv-cs-ai": "https://rss.arxiv.org/rss/cs.AI",
    },
    reddit: ["science", "Physics"],
    hn_keywords: ["research", "paper", "arxiv"],
  },
  startup: {
    label: "Startups / Tech Business",
    keywords: ["startup", "venture", "funding", "ipo", "acquisition", "y combinator", "product launch"],
    rss: {
      "techcrunch": "https://techcrunch.com/feed/",
    },
    reddit: ["startups", "Entrepreneur"],
    hn_keywords: ["yc", "startup", "launch"],
  },
};

// ── Profile prompt generation ────────────────────────────────

export function getProfilePrompt(token: string): string {
  const p = getProfile(token);
  const sections: string[] = [`## 用户兴趣偏好：${p.name || "未命名"}`];

  if (p.strengths.length) {
    sections.push("### 核心特质", p.strengths.map((s) => `- ${s}`).join("\n"));
  }
  if (p.active_projects.length) {
    sections.push("### 当前项目", p.active_projects.map((s) => `- ${s}`).join("\n"));
  }
  if (p.high_interest.length) {
    sections.push("### 高度关注（日常层 — 每条都要评估匹配度）", p.high_interest.map((s) => `- ${s}`).join("\n"));
  }
  if (p.exploration_interest.length) {
    sections.push("### 探索性关注（探索层 — 每周精选几条）", p.exploration_interest.map((s) => `- ${s}`).join("\n"));
  }
  if (p.noise_filter.length) {
    sections.push("### 过滤掉的噪音（看到这类内容直接跳过）", p.noise_filter.map((s) => `- ${s}`).join("\n"));
  }

  return sections.join("\n");
}

// ── Source recommendation ────────────────────────────────────

export function suggestSources(token: string) {
  const profile = getProfile(token);
  const textPool = [
    ...profile.high_interest,
    ...profile.exploration_interest,
    ...profile.active_projects,
    ...profile.strengths,
  ];
  const poolLower = textPool.join(" ").toLowerCase();

  const matched: Record<string, { label: string; match_score: number; rss: Record<string, string>; reddit: string[]; hn_keywords: string[] }> = {};

  for (const [catId, cat] of Object.entries(SOURCE_CATALOG)) {
    const score = cat.keywords.filter((kw) => poolLower.includes(kw.toLowerCase())).length;
    if (score > 0) {
      matched[catId] = {
        label: cat.label,
        match_score: score,
        rss: cat.rss,
        reddit: cat.reddit,
        hn_keywords: cat.hn_keywords,
      };
    }
  }

  // Sort by match score (descending)
  const sorted = Object.fromEntries(
    Object.entries(matched).sort(([, a], [, b]) => b.match_score - a.match_score)
  );

  return {
    matched_categories: sorted,
    instructions:
      "以上是根据用户兴趣偏好匹配的信源分类。请向用户展示推荐结果，" +
      "让用户确认想订阅哪些分类。\n" +
      "用户确认后，调用 briefing_set_sources 传入选定的分类ID列表。\n" +
      "用户也可以手动添加自定义RSS。",
  };
}
