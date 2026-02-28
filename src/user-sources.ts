/**
 * Per-user source configuration
 *
 * Each user can have their own mix of:
 * - Category subscriptions (from SOURCE_CATALOG)
 * - Custom RSS feeds
 * - Custom Reddit subreddits
 * - Custom HN keywords
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";
import { SOURCE_CATALOG } from "./profile.js";

export interface UserSources {
  rss: Record<string, string>;
  reddit: string[];
  hn_keywords: string[];
  subscribed_categories: string[];
  custom_rss: Record<string, string>;
  custom_reddit: string[];
  custom_hn_keywords: string[];
}

const DEFAULT_SOURCES: UserSources = {
  rss: {
    "anthropic-blog": "https://www.anthropic.com/rss.xml",
    "openai-blog": "https://openai.com/blog/rss.xml",
    "google-ai-blog": "https://blog.google/technology/ai/rss/",
    "huggingface-blog": "https://huggingface.co/blog/feed.xml",
    "simon-willison": "https://simonwillison.net/atom/everything/",
    hackaday: "https://hackaday.com/feed/",
    adafruit: "https://blog.adafruit.com/feed/",
  },
  reddit: ["LocalLLaMA", "MachineLearning", "esp32", "IOT", "ClaudeAI"],
  hn_keywords: [
    "ai", "llm", "gpt", "claude", "gemini", "agent", "mcp",
    "esp32", "iot", "edge", "tinyml", "model", "machine learning",
    "deep learning", "anthropic", "openai", "neural", "transformer", "embedding",
  ],
  subscribed_categories: [],
  custom_rss: {},
  custom_reddit: [],
  custom_hn_keywords: [],
};

function sourcesPath(token: string): string {
  return join(getUserDataDir(token), "sources.json");
}

export function getSources(token: string): UserSources {
  return readJSON<UserSources>(sourcesPath(token), { ...DEFAULT_SOURCES });
}

export function setSourcesFromCategories(token: string, categoryIds: string[], keepCustom = true): UserSources {
  const existing = keepCustom ? getSources(token) : { ...DEFAULT_SOURCES };

  const rss: Record<string, string> = {};
  const reddit = new Set<string>();
  const hnKeywords = new Set<string>();

  for (const catId of categoryIds) {
    const cat = SOURCE_CATALOG[catId];
    if (!cat) continue;
    Object.assign(rss, cat.rss);
    cat.reddit.forEach((r: string) => reddit.add(r));
    cat.hn_keywords.forEach((k: string) => hnKeywords.add(k));
  }

  // Merge custom sources
  if (keepCustom) {
    Object.assign(rss, existing.custom_rss || {});
    (existing.custom_reddit || []).forEach((r: string) => reddit.add(r));
    (existing.custom_hn_keywords || []).forEach((k: string) => hnKeywords.add(k));
  }

  const result: UserSources = {
    rss,
    reddit: [...reddit].sort(),
    hn_keywords: [...hnKeywords].sort(),
    subscribed_categories: categoryIds,
    custom_rss: existing.custom_rss || {},
    custom_reddit: existing.custom_reddit || [],
    custom_hn_keywords: existing.custom_hn_keywords || [],
  };

  writeJSON(sourcesPath(token), result);
  return result;
}

export function addCustomSources(
  token: string,
  opts: { rss?: Record<string, string>; reddit?: string[]; hn_keywords?: string[] }
): UserSources {
  const sources = getSources(token);

  if (opts.rss) {
    sources.custom_rss = { ...sources.custom_rss, ...opts.rss };
    sources.rss = { ...sources.rss, ...opts.rss };
  }
  if (opts.reddit) {
    const customSet = new Set(sources.custom_reddit);
    opts.reddit.forEach((r: string) => customSet.add(r));
    sources.custom_reddit = [...customSet].sort();
    const allSet = new Set(sources.reddit);
    opts.reddit.forEach((r: string) => allSet.add(r));
    sources.reddit = [...allSet].sort();
  }
  if (opts.hn_keywords) {
    const customSet = new Set(sources.custom_hn_keywords);
    opts.hn_keywords.forEach((k: string) => customSet.add(k));
    sources.custom_hn_keywords = [...customSet].sort();
    const allSet = new Set(sources.hn_keywords);
    opts.hn_keywords.forEach((k: string) => allSet.add(k));
    sources.hn_keywords = [...allSet].sort();
  }

  writeJSON(sourcesPath(token), sources);
  return sources;
}
