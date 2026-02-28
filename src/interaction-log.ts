/**
 * Interaction log — track user reading & discussion behavior
 */

import { join } from "node:path";
import { getUserDataDir, readJSON, writeJSON } from "./storage.js";

export interface LogEntry {
  timestamp: string;
  date: string;
  action: string;
  article_title: string;
  article_url: string;
  topics: string[];
  notes: string;
}

function logPath(token: string): string {
  return join(getUserDataDir(token), "interaction_log.json");
}

function loadLog(token: string): LogEntry[] {
  return readJSON<LogEntry[]>(logPath(token), []);
}

export function logInteraction(
  token: string,
  action: string,
  articleTitle = "",
  articleUrl = "",
  topics: string[] = [],
  notes = ""
): LogEntry {
  const now = new Date();
  const entry: LogEntry = {
    timestamp: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    action,
    article_title: articleTitle,
    article_url: articleUrl,
    topics,
    notes,
  };

  const log = loadLog(token);
  log.push(entry);
  writeJSON(logPath(token), log);
  return entry;
}

export function getInteractionSummary(token: string, days = 7) {
  const log = loadLog(token);
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const recent = log.filter((e) => e.timestamp >= cutoff);

  const sessions = recent.filter((e) => e.action === "viewed_briefing").length;
  const explored = recent.filter((e) => e.action === "read_detail").length;
  const discussions = recent.filter((e) => e.action === "discussed").length;
  const saves = recent.filter((e) => e.action === "saved");

  const topicCounts: Record<string, number> = {};
  for (const e of recent) {
    for (const t of e.topics) {
      topicCounts[t] = (topicCounts[t] || 0) + 1;
    }
  }
  const topTopics = Object.entries(topicCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  const activity: Record<string, number> = {};
  for (const e of recent) {
    activity[e.date] = (activity[e.date] || 0) + 1;
  }

  return {
    period_days: days,
    total_sessions: sessions,
    articles_explored: explored,
    discussions,
    top_topics: topTopics,
    recent_saves: saves.slice(-5).map((e) => ({
      title: e.article_title,
      url: e.article_url,
      date: e.date,
    })),
    activity_by_date: activity,
  };
}

export function getFullLog(token: string, limit = 50): LogEntry[] {
  const log = loadLog(token);
  return log.slice(-limit);
}
