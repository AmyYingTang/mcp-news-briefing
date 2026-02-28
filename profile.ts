/**
 * User profile — the core of content filtering
 *
 * Profile fields drive how Claude evaluates each article's relevance.
 * Also contains the questionnaire and source catalog for recommendations.
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";

// ── Types ────────────────────────────────────────────────────

export interface UserProfile {
  name: string;
  strengths: string[];
  active_projects: string[];
  high_interest: string[];
  exploration_interest: string[];
  noise_filter: string[];
}

export interface SourceCategory {
  keywords: string[];
  label: string;
  rss: Record<string, string>;
  reddit: string[];
  hn_keywords: string[];
}

// ── Default profile template ─────────────────────────────────

const DEFAULT_PROFILE: UserProfile = {
  name: "",
  strengths: [],
  active_projects: [],
  high_interest: [
    "AI Agent 落地实施和框架选型",
    "AI工具链在实际工程中的应用",
  ],
  exploration_interest: [
    "开源模型发展趋势",
    "新的编程工具和开发者体验",
  ],
  noise_filter: [
    "模型benchmark排名竞赛",
    "AI公司融资和估值新闻",
    "AI末日论或过度乐观的炒作",
  ],
};

// ── Profile questionnaire ────────────────────────────────────

export const PROFILE_QUESTIONNAIRE = {
  instructions:
    "请根据以下问题与用户对话，收集信息后整理成画像JSON，" +
    "调用 briefing_set_profile 提交。\n" +
    "不需要逐字逐条问，自然对话即可，根据用户回答灵活追问。\n" +
    "用户可以跳过任何问题。",
  questions: [
    {
      id: "role",
      question: "你目前的职业/角色是什么？（如：软件工程师、产品经理、独立开发者、学生等）",
      maps_to: "strengths",
      required: false,
    },
    {
      id: "expertise",
      question: "你的核心技术专长或优势是什么？（如：后端开发、系统架构、数据分析、硬件等）",
      maps_to: "strengths",
      required: false,
    },
    {
      id: "projects",
      question: "你目前在做什么项目或方向？（工作相关或个人项目都算）",
      maps_to: "active_projects",
      required: false,
    },
    {
      id: "high_interest",
      question: "你日常最关注哪些技术领域？希望每天都看到相关动态的那种。",
      maps_to: "high_interest",
      required: true,
      examples: "如：MCP生态、AI Agent、ESP32/嵌入式、本地模型部署、前端开发等",
    },
    {
      id: "exploration",
      question: "有没有一些你想探索但不需要天天看的领域？每周看几条就够了。",
      maps_to: "exploration_interest",
      required: false,
      examples: "如：量子计算、生物信息、游戏开发、航天科技等",
    },
    {
      id: "noise",
      question: "有没有你明确不想看到的内容类型？",
      maps_to: "noise_filter",
      required: false,
      examples: "如：融资新闻、benchmark排名、营销PR、加密货币等",
    },
    {
      id: "name",
      question: "最后，简报里怎么称呼你？",
      maps_to: "name",
      required: false,
    },
  ],
  completion_hint:
    "收集完信息后，将回答整理为以下JSON格式并调用 briefing_set_profile：\n" +
    '{\n  "name": "用户名",\n  "strengths": ["特质1", "特质2"],\n' +
    '  "active_projects": ["项目1", "项目2"],\n' +
    '  "high_interest": ["领域1", "领域2"],\n' +
    '  "exploration_interest": ["领域1"],\n' +
    '  "noise_filter": ["不想看的1", "不想看的2"]\n}\n' +
    "然后建议用户调用 briefing_suggest_sources 获取信源推荐。",
};

// ── Source catalog ────────────────────────────────────────────

export const SOURCE_CATALOG: Record<string, SourceCategory> = {
  ai_general: {
    keywords: ["ai", "人工智能", "machine learning", "深度学习", "llm", "大模型", "大语言模型"],
    label: "AI/机器学习 综合",
    rss: {
      "openai-blog": "https://openai.com/blog/rss.xml",
      "google-ai-blog": "https://blog.google/technology/ai/rss/",
      "huggingface-blog": "https://huggingface.co/blog/feed.xml",
    },
    reddit: ["MachineLearning", "LocalLLaMA"],
    hn_keywords: ["ai", "llm", "gpt", "machine learning", "deep learning", "neural", "transformer"],
  },
  anthropic: {
    keywords: ["claude", "anthropic", "mcp", "model context protocol", "claude code"],
    label: "Anthropic/Claude 生态",
    rss: { "anthropic-blog": "https://www.anthropic.com/rss.xml" },
    reddit: ["ClaudeAI"],
    hn_keywords: ["claude", "anthropic", "mcp"],
  },
  ai_agent: {
    keywords: ["agent", "ai agent", "agentic", "langchain", "langgraph", "autogen", "crew"],
    label: "AI Agent 框架与落地",
    rss: {},
    reddit: ["LangChain"],
    hn_keywords: ["agent", "agentic", "langchain"],
  },
  embedded: {
    keywords: ["esp32", "嵌入式", "iot", "物联网", "tinyml", "edge ai", "arduino", "raspberry pi"],
    label: "嵌入式/IoT/Edge AI",
    rss: {
      hackaday: "https://hackaday.com/feed/",
      adafruit: "https://blog.adafruit.com/feed/",
    },
    reddit: ["esp32", "IOT", "arduino"],
    hn_keywords: ["esp32", "iot", "edge", "tinyml", "embedded"],
  },
  open_source_models: {
    keywords: ["开源模型", "open source model", "llama", "mistral", "qwen", "本地部署", "local model"],
    label: "开源模型与本地部署",
    rss: {},
    reddit: ["LocalLLaMA"],
    hn_keywords: ["llama", "mistral", "qwen", "open source", "local"],
  },
  devtools: {
    keywords: ["开发工具", "devtools", "ide", "编辑器", "terminal", "cli", "vscode", "cursor", "编程"],
    label: "开发者工具与体验",
    rss: { "simon-willison": "https://simonwillison.net/atom/everything/" },
    reddit: [],
    hn_keywords: ["developer", "programming", "coding", "ide"],
  },
  astronomy: {
    keywords: ["天文", "astronomy", "航天", "太空", "space", "望远镜", "telescope", "nasa"],
    label: "天文与航天",
    rss: {
      "nasa-breaking": "https://www.nasa.gov/rss/dyn/breaking_news.rss",
      spacenews: "https://spacenews.com/feed/",
    },
    reddit: ["astronomy", "astrophotography", "space"],
    hn_keywords: ["space", "nasa", "telescope", "astronomy"],
  },
  crypto: {
    keywords: ["btc", "bitcoin", "比特币", "crypto", "加密货币", "区块链", "blockchain", "web3"],
    label: "Bitcoin/加密货币",
    rss: {},
    reddit: ["Bitcoin", "CryptoCurrency"],
    hn_keywords: ["bitcoin", "crypto", "blockchain"],
  },
  security: {
    keywords: ["安全", "security", "网络安全", "cybersecurity", "漏洞", "exploit", "渗透"],
    label: "网络安全",
    rss: {
      schneier: "https://www.schneier.com/feed/atom/",
      krebs: "https://krebsonsecurity.com/feed/",
    },
    reddit: ["netsec"],
    hn_keywords: ["security", "vulnerability", "exploit", "hack"],
  },
  rust: {
    keywords: ["rust", "rust语言", "cargo", "tokio"],
    label: "Rust 编程",
    rss: { "rust-blog": "https://blog.rust-lang.org/feed.xml" },
    reddit: ["rust"],
    hn_keywords: ["rust", "cargo", "rustlang"],
  },
  python: {
    keywords: ["python", "django", "flask", "fastapi"],
    label: "Python 生态",
    rss: { "python-insider": "https://blog.python.org/feeds/posts/default?alt=rss" },
    reddit: ["Python"],
    hn_keywords: ["python", "django", "fastapi"],
  },
};

// ── Profile CRUD ─────────────────────────────────────────────

export function getProfile(token: string): UserProfile {
  const path = join(getUserDataDir(token), "profile.json");
  return readJSON<UserProfile>(path, { ...DEFAULT_PROFILE });
}

export function setProfile(token: string, partial: Partial<UserProfile>): UserProfile {
  const existing = getProfile(token);
  const updated = { ...existing, ...partial };
  const path = join(getUserDataDir(token), "profile.json");
  writeJSON(path, updated);
  return updated;
}

export function getProfilePrompt(token: string): string {
  const p = getProfile(token);
  const sections: string[] = [`## 用户画像：${p.name || "未命名"}`];

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
      "以上是根据画像匹配的信源分类。请向用户展示推荐结果，" +
      "让用户确认想订阅哪些分类。\n" +
      "用户确认后，调用 briefing_set_sources 传入选定的分类ID列表。\n" +
      "用户也可以手动添加自定义RSS。",
  };
}
