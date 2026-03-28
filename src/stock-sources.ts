/**
 * Stock news fetching — per-ticker RSS, filtered sources, Reddit, HN
 *
 * Reuses the Article type from sources.ts.
 * Relies on STOCK_SOURCE_CATALOG / resolveSourceUrls from watchlist.ts for URL resolution.
 * Implements: default vs opt-in layering, keyword filtering for "filtered" sources,
 * ASX fallback on fetch failure, per-ticker caching (30-min windows).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import RssParser from "rss-parser";
import { CACHE_DIR, readJSON, writeJSON, cleanupOldCache, log } from "./storage.js";
import { getWatchlist, resolveSourceUrls, STOCK_SOURCE_CATALOG, SHARED_SOURCES, type WatchlistEntry } from "./watchlist.js";
import type { Article } from "./sources.js";

// ── Config ──────────────────────────────────────────────────

const CACHE_TTL_MINUTES = 30;
const FETCH_TIMEOUT_MS = 12_000;
const REDDIT_HEADERS = { "User-Agent": "AIDailyBriefing/2.0 (stock-sources)" };

// ── RSS fetching (per-ticker) ───────────────────────────────

const rssParser = new RssParser();

async function fetchRssUrl(
  url: string,
  sourceName: string,
  hoursBack: number,
): Promise<Article[]> {
  const cutoff = new Date(Date.now() - hoursBack * 3600 * 1000);
  const articles: Article[] = [];

  try {
    const feed = await rssParser.parseURL(url);
    for (const item of (feed.items || []).slice(0, 20)) {
      const pubDate = item.isoDate ? new Date(item.isoDate) : null;
      if (pubDate && pubDate < cutoff) continue;

      const summary = (item.contentSnippet || item.summary || "")
        .replace(/<[^>]+>/g, "")
        .slice(0, 300);

      articles.push({
        title: item.title || "No title",
        url: item.link || "",
        source: `stock-rss:${sourceName}`,
        summary,
        published: pubDate?.toISOString() || "",
        score: 0,
        comments: 0,
      });
    }
  } catch (e) {
    log(`  ⚠️  Stock RSS [${sourceName}]: ${e instanceof Error ? e.message : e}`);
  }

  return articles;
}

// ── Filtered source fetching (full-feed + keyword match) ────

/**
 * Fetch a full RSS feed, then keep only items whose title or summary
 * mention the ticker or company name. Used for broad feeds like CNBC,
 * Stockhead, The Market Herald.
 */
async function fetchFilteredRss(
  url: string,
  sourceName: string,
  ticker: string,
  companyName: string,
  hoursBack: number,
): Promise<Article[]> {
  const raw = await fetchRssUrl(url, sourceName, hoursBack);
  const keywords = buildFilterKeywords(ticker, companyName);
  return raw.filter((a) => matchesKeywords(a.title + " " + a.summary, keywords));
}

function buildFilterKeywords(ticker: string, companyName: string): string[] {
  const kw: string[] = [ticker.toLowerCase()];
  // For ASX tickers like "CBA.AX", also match just "CBA"
  if (ticker.includes(".")) {
    kw.push(ticker.split(".")[0].toLowerCase());
  }
  // Split company name into meaningful words (skip short noise words)
  for (const word of companyName.split(/\s+/)) {
    if (word.length >= 3) kw.push(word.toLowerCase());
  }
  return kw;
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// ── Reddit fetching (stock-specific) ────────────────────────

async function fetchStockReddit(
  ticker: string,
  companyName: string,
  subreddits: string[],
  hoursBack: number,
): Promise<Article[]> {
  const cutoffTs = (Date.now() - hoursBack * 3600 * 1000) / 1000;
  const articles: Article[] = [];
  const searchQuery = encodeURIComponent(ticker);

  for (const sub of subreddits) {
    try {
      const resp = await fetch(
        `https://www.reddit.com/r/${sub}/search.json?q=${searchQuery}&sort=new&t=day&restrict_sr=on&limit=15`,
        { headers: REDDIT_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      const data = (await resp.json()) as {
        data?: { children?: Array<{ data: Record<string, unknown> }> };
      };
      for (const post of data?.data?.children || []) {
        const p = post.data;
        if ((p.created_utc as number) < cutoffTs) continue;
        articles.push({
          title: (p.title as string) || "",
          url: `https://reddit.com${p.permalink as string}`,
          source: `stock-reddit:r/${sub}`,
          summary: ((p.selftext as string) || "").slice(0, 300),
          published: new Date((p.created_utc as number) * 1000).toISOString(),
          score: (p.score as number) || 0,
          comments: (p.num_comments as number) || 0,
        });
      }
    } catch (e) {
      log(`  ⚠️  Stock Reddit [r/${sub} q=${ticker}]: ${e instanceof Error ? e.message : e}`);
    }
  }
  return articles;
}

// ── HN fetching (reuse existing top-stories, filter by company/ticker) ──

async function fetchStockHN(
  ticker: string,
  companyName: string,
  maxItems = 30,
  minScore = 30,
): Promise<Article[]> {
  const keywords = buildFilterKeywords(ticker, companyName);
  const articles: Article[] = [];

  try {
    const resp = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const storyIds = ((await resp.json()) as number[]).slice(0, maxItems);

    for (const sid of storyIds) {
      try {
        const itemResp = await fetch(
          `https://hacker-news.firebaseio.com/v0/item/${sid}.json`,
          { signal: AbortSignal.timeout(5000) },
        );
        const item = (await itemResp.json()) as Record<string, unknown>;
        if (!item || (item.score as number) < minScore) continue;

        const title = ((item.title as string) || "").toLowerCase();
        if (!keywords.some((kw) => title.includes(kw))) continue;

        articles.push({
          title: (item.title as string) || "",
          url: (item.url as string) || `https://news.ycombinator.com/item?id=${sid}`,
          source: "stock-hn",
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
    log(`  ⚠️  Stock HN [${ticker}]: ${e instanceof Error ? e.message : e}`);
  }
  return articles;
}

// ── Per-ticker fetch with fallback ──────────────────────────

async function fetchForTicker(
  ticker: string,
  entry: WatchlistEntry,
  hoursBack: number,
): Promise<Article[]> {
  const catalog = STOCK_SOURCE_CATALOG[entry.market];
  if (!catalog) {
    log(`  ⚠️  Unknown market "${entry.market}" for ${ticker}`);
    return [];
  }

  const { per_ticker_urls, filtered_urls, optin_urls, custom_urls } = resolveSourceUrls(ticker, entry);
  const allArticles: Article[] = [];

  // 1. Per-ticker sources (direct fetch, URL already contains ticker)
  const rssPromises = per_ticker_urls.map((s) =>
    fetchRssUrl(s.url, `${ticker}:${s.name}`, hoursBack),
  );

  // 2. Opt-in sources (user explicitly enabled)
  const optinPromises = optin_urls.map((s) =>
    fetchOptinWithFallback(s.url, s.name, ticker, entry, catalog, hoursBack),
  );

  // 3. Filtered sources (full feed → keep only items matching ticker/company)
  const filteredPromises = filtered_urls.map((s) =>
    fetchFilteredRss(s.url, `${ticker}:${s.name}`, ticker, entry.name, hoursBack),
  );

  // 4. Reddit
  const redditPromise = fetchStockReddit(ticker, entry.name, catalog.reddit, hoursBack);

  // 5. HN
  const hnPromise = fetchStockHN(ticker, entry.name);

  // 6. User-defined custom RSS sources
  const customPromises = custom_urls.map((s) =>
    fetchRssUrl(s.url, `${ticker}:${s.name}`, hoursBack),
  );

  const results = await Promise.allSettled([
    ...rssPromises,
    ...optinPromises,
    ...filteredPromises,
    redditPromise,
    hnPromise,
    ...customPromises,
  ]);

  for (const result of results) {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    }
  }

  return allArticles;
}

/**
 * Fetch an opt-in source. On failure, try the fallback URL if one is
 * configured (e.g. ASX Announcements → Google News AU search).
 */
async function fetchOptinWithFallback(
  primaryUrl: string,
  sourceName: string,
  ticker: string,
  entry: WatchlistEntry,
  catalog: (typeof STOCK_SOURCE_CATALOG)[string],
  hoursBack: number,
): Promise<Article[]> {
  const articles = await fetchRssUrl(primaryUrl, `${ticker}:${sourceName}`, hoursBack);
  if (articles.length > 0) return articles;

  // Check fallback
  const fallbackTpl = catalog.fallbacks[sourceName];
  if (!fallbackTpl) return articles;

  const fallbackUrl = expandUrl(fallbackTpl, ticker, entry);
  log(`  🔄 Fallback for ${sourceName}: ${fallbackUrl}`);
  return fetchRssUrl(fallbackUrl, `${ticker}:${sourceName}:fallback`, hoursBack);
}

function expandUrl(tpl: string, ticker: string, entry: WatchlistEntry): string {
  return tpl
    .replaceAll("{ticker}", ticker.replace(".AX", ""))
    .replaceAll("{company}", encodeURIComponent(entry.name))
    .replaceAll("{sector}", encodeURIComponent(entry.sector))
    .replaceAll("{market_region}", entry.market === "ASX" ? "Australia" : "US")
    .replaceAll("{asx_code}", ticker.replace(".AX", ""));
}

// ── Cache layer ─────────────────────────────────────────────

function stockCacheKey(token: string, hoursBack: number): string {
  const now = new Date();
  const window = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "_",
    String(now.getUTCHours()).padStart(2, "0"),
    "_",
    Math.floor(now.getUTCMinutes() / CACHE_TTL_MINUTES),
  ].join("");
  const tokenHash = createHash("md5").update(token).digest("hex").slice(0, 8);
  return `stock_${window}_h${hoursBack}_${tokenHash}`;
}

// ── Deduplication ───────────────────────────────────────────

function dedup(articles: Article[]): Article[] {
  const seen = new Set<string>();
  return articles.filter((a) => {
    // Normalize URL (strip trailing slashes, query params for some sources)
    const key = a.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Public API ──────────────────────────────────────────────

export interface StockFetchResult {
  total: number;
  by_ticker: Record<string, number>;
  articles: Article[];
}

/**
 * Fetch stock news for all tickers in watchlist (or a subset).
 * Results are cached per user + time window.
 */
export async function fetchStockNews(
  token: string,
  hoursBack = 24,
  tickers?: string[],
): Promise<StockFetchResult> {
  const wl = getWatchlist(token);
  const targetTickers = tickers?.length
    ? tickers.filter((t) => t in wl)
    : Object.keys(wl);

  if (targetTickers.length === 0) {
    return { total: 0, by_ticker: {}, articles: [] };
  }

  // Check cache
  const key = stockCacheKey(token, hoursBack);
  const cachePath = join(CACHE_DIR, `${key}.json`);

  if (existsSync(cachePath)) {
    const cached = readJSON<StockFetchResult>(cachePath, { total: 0, by_ticker: {}, articles: [] });
    if (cached.total > 0) {
      log(`📦 Stock cache hit: ${key} (${cached.total} articles)`);
      // If specific tickers requested, filter cached result
      if (tickers?.length) {
        const tickerSet = new Set(tickers.map((t) => t.toUpperCase()));
        const filtered = cached.articles.filter((a) => {
          // Source format: stock-rss:AAPL:Yahoo Finance
          const parts = a.source.split(":");
          const articleTicker = parts[1]?.split(":")[0];
          return articleTicker ? tickerSet.has(articleTicker.toUpperCase()) : false;
        });
        return {
          total: filtered.length,
          by_ticker: countByTicker(filtered),
          articles: filtered,
        };
      }
      return cached;
    }
  }

  // Fetch all tickers in parallel
  log(`📡 Fetching stock news for: ${targetTickers.join(", ")}...`);
  const fetchPromises = targetTickers.map((ticker) =>
    fetchForTicker(ticker, wl[ticker], hoursBack).then((articles) => ({
      ticker,
      articles,
    })),
  );

  const results = await Promise.allSettled(fetchPromises);
  const allArticles: Article[] = [];
  const byTicker: Record<string, number> = {};

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { ticker, articles } = result.value;
      byTicker[ticker] = articles.length;
      allArticles.push(...articles);
      log(`  📊 ${ticker}: ${articles.length} articles`);
    } else {
      log(`  ⚠️  Ticker fetch failed: ${result.reason}`);
    }
  }

  // Dedup and sort by published date (newest first)
  const unique = dedup(allArticles).sort((a, b) => {
    const ta = a.published ? new Date(a.published).getTime() : 0;
    const tb = b.published ? new Date(b.published).getTime() : 0;
    return tb - ta;
  });

  const fetchResult: StockFetchResult = {
    total: unique.length,
    by_ticker: byTicker,
    articles: unique,
  };

  // Write cache
  writeJSON(cachePath, fetchResult);
  log(`💾 Stock cached: ${key} (${unique.length} articles)`);
  cleanupOldCache();

  return fetchResult;
}

/**
 * Load cached stock articles for a given ticker (or all).
 * Returns articles + the ticker's focus config for Claude analysis.
 */
export function loadStockArticles(
  token: string,
  ticker?: string,
): { articles: Article[]; focus?: string[] } {
  const wl = getWatchlist(token);

  // Find the most recent stock cache file for this user
  const tokenHash = createHash("md5").update(token).digest("hex").slice(0, 8);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // Try current cache window first
  for (let minuteWindow = Math.floor(new Date().getUTCMinutes() / CACHE_TTL_MINUTES); minuteWindow >= 0; minuteWindow--) {
    for (let hour = new Date().getUTCHours(); hour >= 0; hour--) {
      const window = `${today}_${String(hour).padStart(2, "0")}_${minuteWindow}`;
      for (const h of [24, 48, 168]) {
        const key = `stock_${window}_h${h}_${tokenHash}`;
        const cachePath = join(CACHE_DIR, `${key}.json`);
        if (existsSync(cachePath)) {
          const cached = readJSON<StockFetchResult>(cachePath, { total: 0, by_ticker: {}, articles: [] });
          if (cached.total > 0) {
            let articles = cached.articles;
            let focus: string[] | undefined;

            if (ticker) {
              const keywords = buildFilterKeywords(ticker, wl[ticker]?.name || "");
              articles = articles.filter((a) => {
                // Match by source tag or by content keywords
                if (a.source.includes(ticker)) return true;
                return matchesKeywords(a.title, keywords);
              });
              focus = wl[ticker]?.focus;
            }

            return { articles, focus };
          }
        }
      }
    }
  }

  return { articles: [], focus: ticker ? wl[ticker]?.focus : undefined };
}

// ── Helpers ─────────────────────────────────────────────────

function countByTicker(articles: Article[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const a of articles) {
    // Extract ticker from source tag like "stock-rss:AAPL:Yahoo Finance"
    const match = a.source.match(/^stock-\w+:([^:]+)/);
    const ticker = match?.[1] || "unknown";
    counts[ticker] = (counts[ticker] || 0) + 1;
  }
  return counts;
}
