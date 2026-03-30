/**
 * Stock watchlist — CRUD, focus catalog, default focus recommendation, source catalog, alerts
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";

// ── Types ───────────────────────────────────────────────────

export type Market = "US" | "ASX";

export interface CustomSource {
  type: "rss";
  url: string;
}

// ── Alert types ─────────────────────────────────────────────

export type AlertSensitivity = "loose" | "normal" | "strict";
export type AlertStatus = "active" | "triggered" | "expired" | "dismissed";

export interface EventSignature {
  event_date: string;   // ISO date of the event itself (not the news publish date)
  summary: string;      // One-line event summary for semantic dedup
}

export interface TriggerHistoryEntry {
  triggered_at: string;            // ISO timestamp when Claude triggered the alert
  event_signature: EventSignature;
  source_urls: string[];           // Articles reporting this event (appended on dups)
  is_update?: boolean;             // True if this is a material update to a prior event
}

export interface StockAlert {
  id: string;
  description: string;
  keywords: string[];
  source_report: string;
  created_at: string;
  expires_at: string;
  sensitivity: AlertSensitivity;
  status: AlertStatus;
  triggered_count: number;
  last_triggered_at: string | null;
  trigger_history: TriggerHistoryEntry[];
}

export interface AlertScope {
  markets: string[];
  sectors: string[];
  tickers: string[];
}

export interface GlobalAlert extends StockAlert {
  scope: AlertScope;
}

export interface AlertInput {
  description: string;
  keywords: string[];
  expires_in_months?: number;
  sensitivity?: AlertSensitivity;
  source_report?: string;
}

export interface GlobalAlertInput extends AlertInput {
  scope?: AlertScope;
}

// ── Watchlist entry ─────────────────────────────────────────

export interface WatchlistEntry {
  name: string;
  market: Market;
  sector: string;
  focus: string[];
  optin_sources: string[];
  custom_sources: CustomSource[];
  alerts: StockAlert[];
  added_at: string;
}

const MAX_ALERTS_PER_TICKER = 10;

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
    alerts: wl[ticker]?.alerts ?? [],
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

// ── Alert CRUD ──────────────────────────────────────────────

function nextAlertId(prefix: string, existing: StockAlert[]): string {
  const nums = existing
    .map((a) => parseInt(a.id.split("_").pop() || "0", 10))
    .filter((n) => !isNaN(n));
  const next = (nums.length > 0 ? Math.max(...nums) : 0) + 1;
  return `alert_${prefix.toLowerCase()}_${String(next).padStart(3, "0")}`;
}

/**
 * Batch-create alerts for a ticker.
 * Enforces MAX_ALERTS_PER_TICKER limit.
 */
export function setAlerts(
  token: string,
  ticker: string,
  inputs: AlertInput[],
): { alerts: StockAlert[]; error?: string } {
  const wl = getWatchlist(token);
  const entry = wl[ticker];
  if (!entry) return { alerts: [], error: `${ticker} 不在 watchlist 中` };

  if (!entry.alerts) entry.alerts = [];

  const activeCount = entry.alerts.filter((a) => a.status === "active" || a.status === "triggered").length;
  const slotsLeft = MAX_ALERTS_PER_TICKER - activeCount;
  if (inputs.length > slotsLeft) {
    return {
      alerts: [],
      error: `${ticker} 已有 ${activeCount} 条活跃预警，最多 ${MAX_ALERTS_PER_TICKER} 条。还能添加 ${slotsLeft} 条。`,
    };
  }

  const now = new Date().toISOString();
  const created: StockAlert[] = [];

  for (const input of inputs) {
    const months = input.expires_in_months ?? 6;
    const expiresAt = new Date(Date.now() + months * 30 * 86400 * 1000).toISOString();
    const alert: StockAlert = {
      id: nextAlertId(ticker, entry.alerts),
      description: input.description,
      keywords: input.keywords,
      source_report: input.source_report ?? "用户手动创建",
      created_at: now,
      expires_at: expiresAt,
      sensitivity: input.sensitivity ?? "normal",
      status: "active",
      triggered_count: 0,
      last_triggered_at: null,
      trigger_history: [],
    };
    entry.alerts.push(alert);
    created.push(alert);
  }

  writeJSON(watchlistPath(token), wl);
  return { alerts: created };
}

/**
 * List alerts. If ticker is provided, list that ticker's alerts.
 * Otherwise list all alerts across all tickers.
 * Also includes global alerts.
 */
export function listAlerts(
  token: string,
  ticker?: string,
  statusFilter: "active" | "all" = "all",
): { ticker_alerts: Record<string, StockAlert[]>; global_alerts: GlobalAlert[] } {
  const wl = getWatchlist(token);
  const tickerAlerts: Record<string, StockAlert[]> = {};

  const tickers = ticker ? [ticker] : Object.keys(wl);
  for (const t of tickers) {
    const entry = wl[t];
    if (!entry) continue;
    let alerts = entry.alerts || [];
    if (statusFilter === "active") {
      alerts = alerts.filter((a) => a.status === "active" || a.status === "triggered");
    }
    if (alerts.length > 0) tickerAlerts[t] = alerts;
  }

  let globals = getGlobalAlerts(token);
  if (statusFilter === "active") {
    globals = globals.filter((a) => a.status === "active" || a.status === "triggered");
  }

  return { ticker_alerts: tickerAlerts, global_alerts: globals };
}

/**
 * Update a single alert by ID (searches across all tickers + global).
 */
export function updateAlert(
  token: string,
  alertId: string,
  changes: {
    sensitivity?: AlertSensitivity;
    extend_months?: number;
    add_keywords?: string[];
    remove_keywords?: string[];
    description?: string;
    status?: "dismissed";
  },
): StockAlert | GlobalAlert | null {
  // Search in ticker alerts
  const wl = getWatchlist(token);
  for (const entry of Object.values(wl)) {
    if (!entry.alerts) continue;
    const alert = entry.alerts.find((a) => a.id === alertId);
    if (alert) {
      applyAlertChanges(alert, changes);
      writeJSON(watchlistPath(token), wl);
      return alert;
    }
  }

  // Search in global alerts
  const globals = getGlobalAlerts(token);
  const globalAlert = globals.find((a) => a.id === alertId);
  if (globalAlert) {
    applyAlertChanges(globalAlert, changes);
    writeJSON(globalAlertsPath(token), globals);
    return globalAlert;
  }

  return null;
}

function applyAlertChanges(
  alert: StockAlert,
  changes: {
    sensitivity?: AlertSensitivity;
    extend_months?: number;
    add_keywords?: string[];
    remove_keywords?: string[];
    description?: string;
    status?: "dismissed";
  },
): void {
  if (changes.sensitivity) alert.sensitivity = changes.sensitivity;
  if (changes.description) alert.description = changes.description;
  if (changes.status === "dismissed") alert.status = "dismissed";
  if (changes.extend_months) {
    const current = new Date(alert.expires_at);
    current.setDate(current.getDate() + changes.extend_months * 30);
    alert.expires_at = current.toISOString();
  }
  if (changes.add_keywords) {
    const set = new Set(alert.keywords);
    for (const kw of changes.add_keywords) set.add(kw);
    alert.keywords = [...set];
  }
  if (changes.remove_keywords) {
    const removeSet = new Set(changes.remove_keywords);
    alert.keywords = alert.keywords.filter((kw) => !removeSet.has(kw));
  }
}

/**
 * Dismiss one or more alerts by ID.
 */
export function dismissAlerts(
  token: string,
  alertIds: string[],
): string[] {
  const idSet = new Set(alertIds);
  const dismissed: string[] = [];

  const wl = getWatchlist(token);
  for (const entry of Object.values(wl)) {
    if (!entry.alerts) continue;
    for (const alert of entry.alerts) {
      if (idSet.has(alert.id) && alert.status !== "dismissed") {
        alert.status = "dismissed";
        dismissed.push(alert.id);
      }
    }
  }
  writeJSON(watchlistPath(token), wl);

  const globals = getGlobalAlerts(token);
  for (const alert of globals) {
    if (idSet.has(alert.id) && alert.status !== "dismissed") {
      alert.status = "dismissed";
      dismissed.push(alert.id);
    }
  }
  writeJSON(globalAlertsPath(token), globals);

  return dismissed;
}

/**
 * Check and expire stale alerts. Called during stock_fetch / stock_digest.
 */
const ALERT_RETENTION_MS = 180 * 86400 * 1000; // 6 months

export function expireStaleAlerts(token: string): void {
  const now = new Date().toISOString();
  const retentionCutoff = new Date(Date.now() - ALERT_RETENTION_MS).toISOString();

  const wl = getWatchlist(token);
  let changed = false;
  for (const entry of Object.values(wl)) {
    if (!entry.alerts) continue;
    // Expire active alerts past their window
    for (const alert of entry.alerts) {
      if ((alert.status === "active" || alert.status === "triggered") && alert.expires_at < now) {
        alert.status = "expired";
        changed = true;
      }
    }
    // Purge expired/dismissed alerts older than 6 months
    const before = entry.alerts.length;
    entry.alerts = entry.alerts.filter((a) =>
      (a.status !== "expired" && a.status !== "dismissed") || a.expires_at > retentionCutoff,
    );
    if (entry.alerts.length !== before) changed = true;
  }
  if (changed) writeJSON(watchlistPath(token), wl);

  const globals = getGlobalAlerts(token);
  let globalChanged = false;
  for (const alert of globals) {
    if ((alert.status === "active" || alert.status === "triggered") && alert.expires_at < now) {
      alert.status = "expired";
      globalChanged = true;
    }
  }
  const beforeG = globals.length;
  const filtered = globals.filter((a) =>
    (a.status !== "expired" && a.status !== "dismissed") || a.expires_at > retentionCutoff,
  );
  if (filtered.length !== beforeG) globalChanged = true;
  if (globalChanged) writeJSON(globalAlertsPath(token), filtered);
}

/**
 * Find an alert by ID across ticker alerts and global alerts.
 * Returns the alert and a save function to persist changes.
 */
function findAlertById(
  token: string,
  alertId: string,
): { alert: StockAlert | GlobalAlert; save: () => void } | null {
  const wl = getWatchlist(token);
  for (const entry of Object.values(wl)) {
    if (!entry.alerts) continue;
    const alert = entry.alerts.find((a) => a.id === alertId);
    if (alert) {
      return { alert, save: () => writeJSON(watchlistPath(token), wl) };
    }
  }
  const globals = getGlobalAlerts(token);
  const globalAlert = globals.find((a) => a.id === alertId);
  if (globalAlert) {
    return { alert: globalAlert, save: () => writeJSON(globalAlertsPath(token), globals) };
  }
  return null;
}

/** How many days apart two ISO date strings are (absolute). */
function dateDiffDays(a: string, b: string): number {
  const msPerDay = 86400 * 1000;
  return Math.abs(
    (new Date(a.slice(0, 10)).getTime() - new Date(b.slice(0, 10)).getTime()) / msPerDay,
  );
}

export interface TriggerResult {
  action: "new_trigger" | "duplicate_append" | "near_date_found";
  alert_id: string;
  /** Populated when action = "near_date_found": existing entries for Claude to compare. */
  near_entries?: TriggerHistoryEntry[];
}

/**
 * Record an alert trigger with event-level dedup.
 *
 * Flow:
 * 1. Look up trigger_history for entries with event_date within ±3 days.
 * 2. If no near-date entry exists → new trigger (write immediately).
 * 3. If near-date entries exist → return them so Claude can do semantic comparison.
 *    Claude then calls `confirmAlertTrigger` or `appendDuplicateSource`.
 */
export function recordAlertTrigger(
  token: string,
  alertId: string,
  eventSignature: EventSignature,
  sourceUrl: string,
  isUpdate: boolean = false,
): TriggerResult {
  const found = findAlertById(token, alertId);
  if (!found) return { action: "new_trigger", alert_id: alertId };

  const { alert, save } = found;
  // Ensure trigger_history exists (for alerts created before this feature)
  if (!alert.trigger_history) alert.trigger_history = [];

  // Date-level fast filter: find entries within ±3 days
  const nearEntries = alert.trigger_history.filter(
    (entry) => dateDiffDays(entry.event_signature.event_date, eventSignature.event_date) <= 3,
  );

  if (nearEntries.length > 0) {
    // Return near-date entries for Claude to do semantic comparison
    return { action: "near_date_found", alert_id: alertId, near_entries: nearEntries };
  }

  // No near-date match → new event, record immediately
  const now = new Date().toISOString();
  alert.trigger_history.push({
    triggered_at: now,
    event_signature: eventSignature,
    source_urls: [sourceUrl],
    is_update: isUpdate || undefined,
  });
  alert.triggered_count += 1;
  alert.last_triggered_at = now;
  if (alert.status === "active") alert.status = "triggered";
  save();
  return { action: "new_trigger", alert_id: alertId };
}

/**
 * Confirm a trigger after Claude's semantic check determined it's a new event
 * (or a material update to an existing event).
 */
export function confirmAlertTrigger(
  token: string,
  alertId: string,
  eventSignature: EventSignature,
  sourceUrl: string,
  isUpdate: boolean,
): void {
  const found = findAlertById(token, alertId);
  if (!found) return;
  const { alert, save } = found;
  if (!alert.trigger_history) alert.trigger_history = [];
  const now = new Date().toISOString();
  alert.trigger_history.push({
    triggered_at: now,
    event_signature: eventSignature,
    source_urls: [sourceUrl],
    is_update: isUpdate || undefined,
  });
  alert.triggered_count += 1;
  alert.last_triggered_at = now;
  if (alert.status === "active") alert.status = "triggered";
  save();
}

/**
 * Append a source URL to an existing trigger_history entry (duplicate event, different article).
 */
export function appendDuplicateSource(
  token: string,
  alertId: string,
  eventDate: string,
  eventSummary: string,
  sourceUrl: string,
): void {
  const found = findAlertById(token, alertId);
  if (!found) return;
  const { alert, save } = found;
  if (!alert.trigger_history) return;
  // Find the matching entry by date proximity and pick the closest summary match
  const entry = alert.trigger_history.find(
    (e) => dateDiffDays(e.event_signature.event_date, eventDate) <= 3,
  );
  if (entry && !entry.source_urls.includes(sourceUrl)) {
    entry.source_urls.push(sourceUrl);
    save();
  }
}

/**
 * Get all active alerts relevant to a specific ticker
 * (per-stock alerts + matching global alerts).
 */
export function getActiveAlertsForTicker(
  token: string,
  ticker: string,
): { stock_alerts: StockAlert[]; global_alerts: GlobalAlert[] } {
  const wl = getWatchlist(token);
  const entry = wl[ticker];

  const stockAlerts = (entry?.alerts || [])
    .filter((a) => a.status === "active" || a.status === "triggered");

  const globals = getGlobalAlerts(token)
    .filter((a) => a.status === "active" || a.status === "triggered")
    .filter((a) => {
      if (!entry) return false;
      const { scope } = a;
      // Market match
      if (scope.markets.length > 0 && !scope.markets.includes(entry.market)) return false;
      // Sector match (empty = all sectors)
      if (scope.sectors.length > 0 && !scope.sectors.includes(entry.sector)) return false;
      // Ticker match (empty = all tickers in matching market/sector)
      if (scope.tickers.length > 0 && !scope.tickers.includes(ticker)) return false;
      return true;
    });

  return { stock_alerts: stockAlerts, global_alerts: globals };
}

/**
 * Get alerts that are expiring within `days` days. Used for near-expiry reminders.
 */
export function getExpiringAlerts(
  token: string,
  days = 7,
): { ticker: string; alert: StockAlert }[] {
  const cutoff = new Date(Date.now() + days * 86400 * 1000).toISOString();
  const now = new Date().toISOString();
  const results: { ticker: string; alert: StockAlert }[] = [];

  const wl = getWatchlist(token);
  for (const [ticker, entry] of Object.entries(wl)) {
    for (const alert of entry.alerts || []) {
      if ((alert.status === "active" || alert.status === "triggered") &&
          alert.expires_at > now && alert.expires_at <= cutoff) {
        results.push({ ticker, alert });
      }
    }
  }
  return results;
}

/**
 * Get alerts with high noise (>10 triggers in 30 days).
 */
export function getNoisyAlerts(
  token: string,
  threshold = 10,
): { ticker: string; alert: StockAlert }[] {
  const cutoff30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const results: { ticker: string; alert: StockAlert }[] = [];

  const wl = getWatchlist(token);
  for (const [ticker, entry] of Object.entries(wl)) {
    for (const alert of entry.alerts || []) {
      if ((alert.status === "active" || alert.status === "triggered") &&
          alert.triggered_count >= threshold &&
          alert.created_at > cutoff30d) {
        results.push({ ticker, alert });
      }
    }
  }
  return results;
}

// ── Global alerts ───────────────────────────────────────────

function globalAlertsPath(token: string): string {
  return join(getUserDataDir(token), "global_alerts.json");
}

function getGlobalAlerts(token: string): GlobalAlert[] {
  return readJSON<GlobalAlert[]>(globalAlertsPath(token), []);
}

/**
 * Batch-create global alerts (cross-stock, macro-level).
 */
export function setGlobalAlerts(
  token: string,
  inputs: GlobalAlertInput[],
): GlobalAlert[] {
  const existing = getGlobalAlerts(token);
  const now = new Date().toISOString();
  const created: GlobalAlert[] = [];

  for (const input of inputs) {
    const months = input.expires_in_months ?? 6;
    const expiresAt = new Date(Date.now() + months * 30 * 86400 * 1000).toISOString();
    const id = `galert_${String(existing.length + created.length + 1).padStart(3, "0")}`;
    const alert: GlobalAlert = {
      id,
      description: input.description,
      keywords: input.keywords,
      source_report: input.source_report ?? "用户手动创建",
      created_at: now,
      expires_at: expiresAt,
      sensitivity: input.sensitivity ?? "normal",
      status: "active",
      triggered_count: 0,
      last_triggered_at: null,
      trigger_history: [],
      scope: input.scope ?? { markets: [], sectors: [], tickers: [] },
    };
    existing.push(alert);
    created.push(alert);
  }

  writeJSON(globalAlertsPath(token), existing);
  return created;
}
