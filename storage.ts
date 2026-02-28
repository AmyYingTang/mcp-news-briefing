/**
 * Storage utilities — cross-platform data directory & JSON persistence
 *
 * Data layout:
 *   <dataDir>/
 *     tokens.json              — user registry
 *     cache/                   — shared article cache
 *     users/<tokenPrefix>/     — per-user data
 *       profile.json
 *       sources.json
 *       interaction_log.json
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { platform } from "node:process";

// ── Data directory (platform-aware) ──────────────────────────

function getDataDir(): string {
  const p = platform;
  let base: string;
  if (p === "darwin") {
    base = join(homedir(), "Library", "Application Support");
  } else if (p === "win32") {
    base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  } else {
    base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  }
  const dir = join(base, "briefing-mcp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const DATA_DIR = getDataDir();
export const CACHE_DIR = join(DATA_DIR, "cache");
mkdirSync(CACHE_DIR, { recursive: true });

// ── JSON helpers ─────────────────────────────────────────────

export function readJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ── User data directory ──────────────────────────────────────

export function getUserDataDir(token: string): string {
  const short = token.slice(0, 8);
  const dir = join(DATA_DIR, "users", short);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Cache cleanup ────────────────────────────────────────────

export function cleanupOldCache(maxAgeHours = 48): void {
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  if (!existsSync(CACHE_DIR)) return;
  for (const f of readdirSync(CACHE_DIR)) {
    if (!f.startsWith("articles_") || !f.endsWith(".json")) continue;
    const fp = join(CACHE_DIR, f);
    try {
      if (statSync(fp).mtimeMs < cutoff) {
        unlinkSync(fp);
        log(`🗑️  Cleaned old cache: ${f}`);
      }
    } catch { /* ignore */ }
  }
}

// ── Logging (stderr to avoid MCP stdout corruption) ──────────

export function log(msg: string): void {
  process.stderr.write(msg + "\n");
}
