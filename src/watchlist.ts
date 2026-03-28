/**
 * Stock watchlist — CRUD, focus catalog, default focus recommendation, source catalog
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";

// ── Types ───────────────────────────────────────────────────

export type Market = "US" | "ASX";

export interface CustomSource {
  type: "rss";
  url: string;
}

export interface WatchlistEntry {
  name: string;
  market: Market;
  sector: string;
  focus: string[];
  optin_sources: string[];
  custom_sources: CustomSource[];
  added_at: string;
}

/** ticker → entry */
export type Watchlist = Record<string, WatchlistEntry>;

// ── Focus catalog ───────────────────────────────────────────

export interface FocusItem {
  id: string;
  label: string;
  description: string;
  search_template: string;
}

export const FOCUS_CATALOG: FocusItem[] = [
  {
    id: "executive_trades",
    label: "高管增减持",
    description: "内部人士买入/卖出",
    search_template: "{ticker} insider trading OR executive buy OR sell",
  },
  {
    id: "earnings",
    label: "财报与业绩",
    description: "季报、年报、业绩预告",
    search_template: "{ticker} earnings OR revenue OR profit OR guidance",
  },
  {
    id: "product_launch",
    label: "产品发布",
    description: "新产品、重大更新",
    search_template: '{ticker} OR {company} product launch OR release OR announce',
  },
  {
    id: "competitor_share",
    label: "竞争对手动态",
    description: "市场份额变化",
    search_template: "{sector} market share OR competitor",
  },
  {
    id: "regulatory",
    label: "监管政策",
    description: "行业法规、反垄断、合规",
    search_template: "{ticker} OR {sector} regulation OR policy OR antitrust",
  },
  {
    id: "supply_chain",
    label: "供应链",
    description: "供应链中断/调整",
    search_template: "{company} supply chain OR supplier OR shortage",
  },
  {
    id: "analyst_rating",
    label: "分析师评级",
    description: "升降级、目标价",
    search_template: "{ticker} analyst upgrade OR downgrade OR target price",
  },
  {
    id: "litigation",
    label: "诉讼合规",
    description: "重大法律事件",
    search_template: "{ticker} lawsuit OR litigation OR SEC investigation",
  },
  {
    id: "ma_partnership",
    label: "并购合作",
    description: "收购、战略合作",
    search_template: "{ticker} acquisition OR merger OR partnership",
  },
  {
    id: "buyback_dividend",
    label: "回购分红",
    description: "资本回报政策变化",
    search_template: "{ticker} buyback OR share repurchase OR dividend",
  },
  {
    id: "interest_rate_policy",
    label: "利率政策",
    description: "央行利率决议影响",
    search_template: "{market_region} interest rate OR central bank OR RBA OR Fed",
  },
  {
    id: "macro_outlook",
    label: "宏观经济",
    description: "GDP、通胀、就业等",
    search_template: "{market_region} economy OR GDP OR inflation",
  },
];

const FOCUS_BY_ID = new Map(FOCUS_CATALOG.map((f) => [f.id, f]));

export function getFocusItem(id: string): FocusItem | undefined {
  return FOCUS_BY_ID.get(id);
}

// ── Default focus recommendation ────────────────────────────

const BASE_FOCUS = ["executive_trades", "earnings", "product_launch", "regulatory"];

const SECTOR_FOCUS: Record<string, string[]> = {
  Technology: ["competitor_share", "supply_chain"],
  Financials: ["interest_rate_policy", "macro_outlook"],
  Healthcare: ["regulatory", "litigation"],
  Energy: ["macro_outlook", "supply_chain"],
  Consumer: ["competitor_share", "product_launch"],
};

const MARKET_FOCUS: Record<string, string[]> = {
  US: ["analyst_rating"],
  ASX: ["interest_rate_policy", "macro_outlook"],
};

/**
 * Return recommended focus IDs for a given market + sector.
 * Deduplicates automatically.
 */
export function recommendFocus(market: Market, sector: string): string[] {
  const set = new Set(BASE_FOCUS);
  for (const id of SECTOR_FOCUS[sector] ?? []) set.add(id);
  for (const id of MARKET_FOCUS[market] ?? []) set.add(id);
  return [...set];
}

// ── Stock source catalog ────────────────────────────────────

export interface SourceEntry {
  type: "rss" | "sec";
  name: string;
  url?: string;
  cik_lookup?: boolean;
}

export interface MarketSourceConfig {
  default_per_ticker: SourceEntry[];
  default_filtered: SourceEntry[];
  optin_per_ticker: SourceEntry[];
  optin_notice: Record<string, string>;
  reddit: string[];
  fallbacks: Record<string, string>;
}

export const STOCK_SOURCE_CATALOG: Record<string, MarketSourceConfig> = {
  US: {
    default_per_ticker: [
      { type: "rss", name: "Yahoo Finance", url: "https://feeds.finance.yahoo.com/rss/2.0/headline?s={ticker}&region=US&lang=en-US" },
      { type: "rss", name: "Google News US", url: 'https://news.google.com/rss/search?q={ticker}+OR+%22{company}%22&hl=en-US&gl=US&ceid=US:en' },
      { type: "rss", name: "Nasdaq", url: "https://www.nasdaq.com/feed/rssoutbound?symbol={ticker}" },
    ],
    default_filtered: [],
    optin_per_ticker: [
      { type: "sec", name: "SEC EDGAR", cik_lookup: true },
      { type: "rss", name: "Seeking Alpha", url: "https://seekingalpha.com/api/sa/combined/{ticker}.xml" },
    ],
    optin_notice: {
      "SEC EDGAR": "SEC EDGAR 提供官方 filings（含高管增减持 Form 4），公开免费但有频率限制",
      "Seeking Alpha": "Seeking Alpha RSS 仅限个人非商业使用（详见其 Terms of Use）",
    },
    reddit: ["stocks", "wallstreetbets", "investing", "StockMarket"],
    fallbacks: {},
  },
  ASX: {
    default_per_ticker: [
      { type: "rss", name: "Google News AU", url: 'https://news.google.com/rss/search?q={ticker}+ASX+OR+%22{company}%22&hl=en-AU&gl=AU&ceid=AU:en' },
    ],
    default_filtered: [
      { type: "rss", name: "The Market Herald", url: "https://themarketonline.com.au/feed" },
      { type: "rss", name: "Stockhead", url: "https://stockhead.com.au/feed" },
    ],
    optin_per_ticker: [
      { type: "rss", name: "ASX Announcements", url: "http://finance.mooh.org/rss.php?s={ticker}" },
    ],
    optin_notice: {
      "ASX Announcements": "非官方第三方服务（finance.mooh.org），可能不稳定",
    },
    reddit: ["ASX_Bets", "AusFinance"],
    fallbacks: {
      "ASX Announcements": "https://news.google.com/rss/search?q={ticker}+ASX+announcement&hl=en-AU&gl=AU&ceid=AU:en",
    },
  },
};

/** Shared financial sources enabled for all markets */
export const SHARED_SOURCES: SourceEntry[] = [
  { type: "rss", name: "CNBC Finance", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664" },
  { type: "rss", name: "Reuters via Google News", url: "https://news.google.com/rss/search?q=site:reuters.com+{ticker}&hl=en" },
];

// ── Watchlist CRUD ──────────────────────────────────────────

function watchlistPath(token: string): string {
  return join(getUserDataDir(token), "watchlist.json");
}

export function getWatchlist(token: string): Watchlist {
  return readJSON<Watchlist>(watchlistPath(token), {});
}

/**
 * Add or overwrite a single watchlist entry.
 * If `focus` is not provided, uses recommendFocus().
 * Returns the full updated entry plus available opt-in notices.
 */
export function setWatchlistEntry(
  token: string,
  ticker: string,
  input: {
    name: string;
    market: Market;
    sector?: string;
    focus?: string[];
    optin_sources?: string[];
    custom_sources?: CustomSource[];
  },
): { entry: WatchlistEntry; recommended_focus: string[]; optin_notices: Record<string, string> } {
  const wl = getWatchlist(token);
  const sector = input.sector || "Other";
  const recommended = recommendFocus(input.market, sector);
  const focus = input.focus ?? recommended;

  const entry: WatchlistEntry = {
    name: input.name,
    market: input.market,
    sector,
    focus,
    optin_sources: input.optin_sources ?? [],
    custom_sources: input.custom_sources ?? [],
    added_at: wl[ticker]?.added_at ?? new Date().toISOString(),
  };

  wl[ticker] = entry;
  writeJSON(watchlistPath(token), wl);

  // Collect opt-in notices for this market
  const catalog = STOCK_SOURCE_CATALOG[input.market];
  const optin_notices = catalog?.optin_notice ?? {};

  return { entry, recommended_focus: recommended, optin_notices };
}

/**
 * Remove a ticker from watchlist. Returns true if it existed.
 */
export function removeWatchlistEntry(token: string, ticker: string): boolean {
  const wl = getWatchlist(token);
  if (!(ticker in wl)) return false;
  delete wl[ticker];
  writeJSON(watchlistPath(token), wl);
  return true;
}

/**
 * Add/remove focus items for a specific ticker.
 * Returns the updated focus list, or null if ticker not found.
 */
export function updateFocus(
  token: string,
  ticker: string,
  addFocus?: string[],
  removeFocus?: string[],
): string[] | null {
  const wl = getWatchlist(token);
  const entry = wl[ticker];
  if (!entry) return null;

  const focusSet = new Set(entry.focus);
  if (addFocus) {
    for (const id of addFocus) {
      if (FOCUS_BY_ID.has(id)) focusSet.add(id);
    }
  }
  if (removeFocus) {
    for (const id of removeFocus) focusSet.delete(id);
  }

  entry.focus = [...focusSet];
  writeJSON(watchlistPath(token), wl);
  return entry.focus;
}

/**
 * Add or remove custom RSS sources for a specific ticker.
 * Returns the updated custom_sources list, or null if ticker not found.
 */
export function updateCustomSources(
  token: string,
  ticker: string,
  addSources?: CustomSource[],
  removeSources?: string[],
): CustomSource[] | null {
  const wl = getWatchlist(token);
  const entry = wl[ticker];
  if (!entry) return null;

  const sources = entry.custom_sources || [];
  const urlSet = new Set(sources.map((s) => s.url));

  // Add new sources (deduplicate by URL)
  if (addSources) {
    for (const cs of addSources) {
      if (!urlSet.has(cs.url)) {
        sources.push(cs);
        urlSet.add(cs.url);
      }
    }
  }

  // Remove by URL
  if (removeSources) {
    const removeSet = new Set(removeSources);
    entry.custom_sources = sources.filter((s) => !removeSet.has(s.url));
  } else {
    entry.custom_sources = sources;
  }

  writeJSON(watchlistPath(token), wl);
  return entry.custom_sources;
}

/**
 * Get the resolved source URLs for a specific ticker entry.
 * Replaces {ticker}, {company}, {sector}, {market_region} placeholders.
 */
export interface ResolvedUrls {
  /** Per-ticker sources (direct fetch, no filtering needed) */
  per_ticker_urls: { name: string; url: string }[];
  /** Filtered sources (full feed, needs keyword matching) */
  filtered_urls: { name: string; url: string }[];
  /** Opt-in sources (user explicitly enabled) */
  optin_urls: { name: string; url: string }[];
  /** User-defined custom RSS sources */
  custom_urls: { name: string; url: string }[];
}

export function resolveSourceUrls(
  ticker: string,
  entry: WatchlistEntry,
): ResolvedUrls {
  const catalog = STOCK_SOURCE_CATALOG[entry.market];
  if (!catalog) return { per_ticker_urls: [], filtered_urls: [], optin_urls: [], custom_urls: [] };

  const vars: Record<string, string> = {
    "{ticker}": ticker.replace(".AX", ""),
    "{company}": encodeURIComponent(entry.name),
    "{sector}": encodeURIComponent(entry.sector),
    "{market_region}": entry.market === "ASX" ? "Australia" : "US",
    "{asx_code}": ticker.replace(".AX", ""),
  };

  function expand(tpl: string): string {
    let result = tpl;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replaceAll(k, v);
    }
    return result;
  }

  function mapSources(sources: SourceEntry[]): { name: string; url: string }[] {
    return sources
      .filter((s) => s.url)
      .map((s) => ({ name: s.name, url: expand(s.url!) }));
  }

  const per_ticker_urls = mapSources(catalog.default_per_ticker);

  const filtered_urls = [
    ...mapSources(catalog.default_filtered),
    ...mapSources(SHARED_SOURCES),
  ];

  const enabledOptins = new Set(entry.optin_sources);
  const optin_urls = catalog.optin_per_ticker
    .filter((s) => enabledOptins.has(s.name) && s.url)
    .map((s) => ({ name: s.name, url: expand(s.url!) }));

  // User-defined custom RSS sources (URLs may contain {ticker}/{company} placeholders)
  const custom_urls = (entry.custom_sources || []).map((cs, i) => ({
    name: `custom-${i + 1}`,
    url: expand(cs.url),
  }));

  return { per_ticker_urls, filtered_urls, optin_urls, custom_urls };
}
