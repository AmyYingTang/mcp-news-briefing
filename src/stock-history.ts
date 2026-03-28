/**
 * Stock history — sentiment snapshots, close price fetching, divergence detection
 *
 * Each stock_digest analysis produces a snapshot (recorded by Claude via
 * briefing_stock_history_record). Over time these snapshots enable trend
 * analysis and sentiment-vs-price divergence alerts.
 *
 * Storage: users/<tokenPrefix>/stock-history/<TICKER>.json
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { getUserDataDir, readJSON, writeJSON, log } from "./storage.js";

// ── Types ───────────────────────────────────────────────────

export interface SentimentBreakdown {
  strong_bullish: number;
  weak_bullish: number;
  neutral: number;
  weak_bearish: number;
  strong_bearish: number;
}

export interface SentimentSnapshot {
  date: string;                    // YYYY-MM-DD
  sentiment_score: number;         // weighted average: +2/+1/0/-1/-2
  sentiment_label: string;         // 强利好 / 偏利好 / 中性 / 偏利空 / 强利空
  article_count: number;
  breakdown: SentimentBreakdown;
  key_events: string[];            // 🟢🟢 or 🔴🔴 level headlines
  close_price?: number;            // end-of-day price (USD/AUD)
  price_change_pct?: number;       // daily change %
  price_source?: string;           // "yahoo" | "claude"
}

export interface StockHistory {
  ticker: string;
  snapshots: SentimentSnapshot[];
}

// ── Sentiment scoring helpers ───────────────────────────────

export function computeSentimentLabel(score: number): string {
  if (score > 1.0)  return "强利好";
  if (score > 0.3)  return "偏利好";
  if (score > -0.3) return "中性";
  if (score > -1.0) return "偏利空";
  return "强利空";
}

// ── Storage ─────────────────────────────────────────────────

function historyDir(token: string): string {
  const dir = join(getUserDataDir(token), "stock-history");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function historyPath(token: string, ticker: string): string {
  return join(historyDir(token), `${ticker.toUpperCase()}.json`);
}

function loadHistory(token: string, ticker: string): StockHistory {
  return readJSON<StockHistory>(historyPath(token, ticker), {
    ticker: ticker.toUpperCase(),
    snapshots: [],
  });
}

// ── CRUD ────────────────────────────────────────────────────

/**
 * Record a sentiment snapshot for a ticker on a given date.
 * If a snapshot for the same date already exists, it is replaced.
 */
export function recordSnapshot(
  token: string,
  ticker: string,
  snapshot: SentimentSnapshot,
): SentimentSnapshot {
  const history = loadHistory(token, ticker);

  // Replace existing snapshot for same date, or append
  const idx = history.snapshots.findIndex((s) => s.date === snapshot.date);
  if (idx >= 0) {
    history.snapshots[idx] = snapshot;
  } else {
    history.snapshots.push(snapshot);
  }

  // Keep sorted by date, cap at 90 days
  history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (history.snapshots.length > 90) {
    history.snapshots = history.snapshots.slice(-90);
  }

  writeJSON(historyPath(token, ticker), history);
  return snapshot;
}

/**
 * Get recent snapshots for a ticker.
 */
export function getSnapshots(
  token: string,
  ticker: string,
  days = 7,
): SentimentSnapshot[] {
  const history = loadHistory(token, ticker);
  return history.snapshots.slice(-days);
}

// ── Close price fetching (Yahoo Finance) ────────────────────

const YAHOO_TIMEOUT_MS = 10_000;

/**
 * Fetch the latest close price from Yahoo Finance.
 * Returns { close, changePct } or null on failure.
 */
export async function fetchClosePrice(
  ticker: string,
): Promise<{ close: number; changePct: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "mcp-news-briefing/1.0" },
      signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
    });

    if (!resp.ok) {
      log(`  ⚠️  Yahoo Finance [${ticker}]: HTTP ${resp.status}`);
      return null;
    }

    const data = (await resp.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
          };
        }>;
      };
    };

    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) {
      log(`  ⚠️  Yahoo Finance [${ticker}]: no price data`);
      return null;
    }

    const close = meta.regularMarketPrice;
    const prevClose = meta.previousClose || close;
    const changePct = prevClose !== 0
      ? ((close - prevClose) / prevClose) * 100
      : 0;

    return { close: Math.round(close * 100) / 100, changePct: Math.round(changePct * 100) / 100 };
  } catch (e) {
    log(`  ⚠️  Yahoo Finance [${ticker}]: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ── Divergence detection ────────────────────────────────────

export interface DivergenceResult {
  detected: boolean;
  type?: "bullish_sentiment_bearish_price" | "bearish_sentiment_bullish_price";
  avg_sentiment: number;
  price_trend_pct: number;
  description?: string;
}

/**
 * Check for sentiment-vs-price divergence over recent snapshots.
 * Requires at least 5 snapshots with price data.
 */
export function detectDivergence(
  snapshots: SentimentSnapshot[],
): DivergenceResult {
  // Need at least 5 days with price data
  const withPrice = snapshots.filter((s) => s.close_price != null && s.price_change_pct != null);
  if (withPrice.length < 5) {
    return { detected: false, avg_sentiment: 0, price_trend_pct: 0 };
  }

  const recent = withPrice.slice(-5);
  const avgSentiment = recent.reduce((sum, s) => sum + s.sentiment_score, 0) / recent.length;

  // Cumulative price change over the window
  let cumulativePct = 0;
  for (const s of recent) {
    cumulativePct += s.price_change_pct!;
  }

  const result: DivergenceResult = {
    detected: false,
    avg_sentiment: Math.round(avgSentiment * 100) / 100,
    price_trend_pct: Math.round(cumulativePct * 100) / 100,
  };

  // Bullish sentiment + bearish price
  if (avgSentiment > 0.5 && cumulativePct < -3) {
    result.detected = true;
    result.type = "bullish_sentiment_bearish_price";
    result.description =
      `近 5 天情绪偏正面（均值 ${result.avg_sentiment}），但股价累计下跌 ${result.price_trend_pct}%。` +
      "可能原因：消息已被 price in、宏观/系统性风险压过个股利好、或有未被抓到的利空消息。";
  }

  // Bearish sentiment + bullish price
  if (avgSentiment < -0.5 && cumulativePct > 3) {
    result.detected = true;
    result.type = "bearish_sentiment_bullish_price";
    result.description =
      `近 5 天情绪偏负面（均值 ${result.avg_sentiment}），但股价累计上涨 ${result.price_trend_pct}%。` +
      "可能原因：超卖反弹、利空出尽、市场预期已提前转变。";
  }

  return result;
}
