/**
 * Article fetching — RSS, Reddit, Hacker News
 * With shared caching layer (30-min windows)
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import RssParser from "rss-parser";
import { DATA_DIR, CACHE_DIR, readJSON, writeJSON, cleanupOldCache, log } from "./storage.js";
import type { UserSources } from "./user-sources.js";

// ── Types ────────────────────────────────────────────────────

export interface Article {
  title: string;
  url: string;
  source: string;
  summary: string;
  published: string;
  score: number;
  comments: number;
}

const CACHE_TTL_MINUTES = 30;
const REDDIT_HEADERS = { "User-Agent": "AIDailyBriefing/2.0" };

// ── Default sources (used when no user sources configured) ───

const DEFAULT_RSS: Record<string, string> = {
  "anthropic-blog": "https://www.anthropic.com/rss.xml",
  "openai-blog": "https://openai.com/blog/rss.xml",
  "google-ai-blog": "https://blog.google/technology/ai/rss/",
  "huggingface-blog": "https://huggingface.co/blog/feed.xml",
  "simon-willison": "https://simonwillison.net/atom/everything/",
  hackaday: "https://hackaday.com/feed/",
  adafruit: "https://blog.adafruit.com/feed/",
};

const DEFAULT_SUBS = ["LocalLLaMA", "MachineLearning", "esp32", "IOT", "ClaudeAI"];

const DEFAULT_HN_KEYWORDS = [
  "ai", "llm", "gpt", "claude", "gemini", "agent", "mcp",
  "esp32", "iot", "edge", "tinyml", "model", "machine learning",
  "deep learning", "anthropic", "openai", "neural", "transformer", "embedding",
];

// ── RSS fetching ─────────────────────────────────────────────

async function fetchRss(hoursBack: number, feeds?: Record<string, string>): Promise<Article[]> {
  const parser = new RssParser();
  const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000);
  const targetFeeds = feeds ?? DEFAULT_RSS;
  const articles: Article[] = [];

  for (const [name, url] of Object.entries(targetFeeds)) {
    try {
      const feed = await parser.parseURL(url);
      for (const item of (feed.items || []).slice(0, 15)) {
        const pubDate = item.isoDate ? new Date(item.isoDate) : null;
        if (pubDate && pubDate < cutoff) continue;

        const summary = (item.contentSnippet || item.summary || "")
          .replace(/<[^>]+>/g, "")
          .slice(0, 300);

        articles.push({
          title: item.title || "No title",
          url: item.link || "",
          source: `rss:${name}`,
          summary,
          published: pubDate?.toISOString() || "",
          score: 0,
          comments: 0,
        });
      }
    } catch (e) {
      log(`  ⚠️  RSS [${name}]: ${e instanceof Error ? e.message : e}`);
    }
  }
  return articles;
}

// ── Reddit fetching ──────────────────────────────────────────

async function fetchReddit(hoursBack: number, minScore = 20, subs?: string[]): Promise<Article[]> {
  const cutoffTs = (Date.now() - hoursBack * 3600 * 1000) / 1000;
  const targetSubs = subs ?? DEFAULT_SUBS;
  const articles: Article[] = [];

  for (const sub of targetSubs) {
    try {
      const resp = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=20`, {
        headers: REDDIT_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json() as { data?: { children?: Array<{ data: Record<string, unknown> }> } };
      for (const post of data?.data?.children || []) {
        const p = post.data;
        if ((p.created_utc as number) < cutoffTs) continue;
        if ((p.score as number) < minScore) continue;
        articles.push({
          title: (p.title as string) || "",
          url: `https://reddit.com${p.permalink as string}`,
          source: `reddit:r/${sub}`,
          summary: ((p.selftext as string) || "").slice(0, 300),
          published: new Date((p.created_utc as number) * 1000).toISOString(),
          score: (p.score as number) || 0,
          comments: (p.num_comments as number) || 0,
        });
      }
    } catch (e) {
      log(`  ⚠️  Reddit [r/${sub}]: ${e instanceof Error ? e.message : e}`);
    }
  }
  return articles;
}

// ── Hacker News fetching ─────────────────────────────────────

async function fetchHackerNews(minScore = 50, maxItems = 30, keywords?: string[]): Promise<Article[]> {
  const targetKeywords = keywords ?? DEFAULT_HN_KEYWORDS;
  const articles: Article[] = [];

  try {
    const resp = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
      signal: AbortSignal.timeout(10000),
    });
    const storyIds = ((await resp.json()) as number[]).slice(0, maxItems);

    for (const sid of storyIds) {
      try {
        const itemResp = await fetch(`https://hacker-news.firebaseio.com/v0/item/${sid}.json`, {
          signal: AbortSignal.timeout(5000),
        });
        const item = (await itemResp.json()) as Record<string, unknown>;
        if (!item || (item.score as number) < minScore) continue;

        const title = ((item.title as string) || "").toLowerCase();
        if (!targetKeywords.some((kw) => title.includes(kw))) continue;

        articles.push({
          title: (item.title as string) || "",
          url: (item.url as string) || `https://news.ycombinator.com/item?id=${sid}`,
          source: "hackernews",
          summary: "",
          published: new Date((item.time as number) * 1000).toISOString(),
          score: (item.score as number) || 0,
          comments: (item.descendants as number) || 0,
        });
      } catch {
        continue;
      }
    }
  } catch (e) {
    log(`  ⚠️  HackerNews: ${e instanceof Error ? e.message : e}`);
  }
  return articles;
}

// ── Cache layer ──────────────────────────────────────────────

function cacheKey(hoursBack: number, userSources?: UserSources | null): string {
  const now = new Date();
  const window = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}_${String(now.getUTCHours()).padStart(2, "0")}_${Math.floor(now.getUTCMinutes() / CACHE_TTL_MINUTES)}`;

  if (userSources) {
    const srcStr = JSON.stringify({
      rss: userSources.rss,
      reddit: userSources.reddit,
      hn_keywords: userSources.hn_keywords,
    });
    const srcHash = createHash("md5").update(srcStr).digest("hex").slice(0, 8);
    return `articles_${window}_h${hoursBack}_${srcHash}`;
  }
  return `articles_${window}_h${hoursBack}_default`;
}

// ── Main entry point ─────────────────────────────────────────

export async function fetchAll(hoursBack = 24, userSources?: UserSources | null): Promise<Article[]> {
  const feeds = userSources?.rss ?? undefined;
  const subs = userSources?.reddit ?? undefined;
  const hnKw = userSources?.hn_keywords ?? undefined;

  const key = cacheKey(hoursBack, userSources);
  const cachePath = join(CACHE_DIR, `${key}.json`);

  // Check cache
  if (existsSync(cachePath)) {
    const cached = readJSON<Article[]>(cachePath, []);
    if (cached.length > 0) {
      log(`📦 Cache hit: ${key} (${cached.length} articles)`);
      return cached;
    }
  }

  // Cache miss — fetch
  log("📡 Fetching sources...");
  const rss = await fetchRss(hoursBack, feeds);
  log(`  📰 RSS: ${rss.length}`);
  const reddit = await fetchReddit(hoursBack, 20, subs);
  log(`  🔴 Reddit: ${reddit.length}`);
  const hn = await fetchHackerNews(50, 30, hnKw);
  log(`  🟠 HN: ${hn.length}`);

  const all = [...rss, ...reddit, ...hn].sort((a, b) => b.score - a.score);

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const unique = all.filter((a) => {
    if (seenUrls.has(a.url)) return false;
    seenUrls.add(a.url);
    return true;
  });

  // Write cache
  writeJSON(cachePath, unique);
  log(`💾 Cached: ${key} (${unique.length} articles)`);

  // Also save daily snapshot
  const today = new Date().toISOString().slice(0, 10);
  writeJSON(join(DATA_DIR, `articles_${today}.json`), unique);

  cleanupOldCache();
  log(`✅ Total: ${unique.length} articles cached`);
  return unique;
}

export function loadTodayArticles(): Article[] {
  const today = new Date().toISOString().slice(0, 10);
  return readJSON<Article[]>(join(DATA_DIR, `articles_${today}.json`), []);
}

export function loadArticlesByDate(dateStr: string): Article[] {
  return readJSON<Article[]>(join(DATA_DIR, `articles_${dateStr}.json`), []);
}
