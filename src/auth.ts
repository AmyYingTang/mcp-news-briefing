/**
 * User token management — lightweight multi-user identity
 *
 * - Register → random token
 * - Resolve by token OR name
 * - Per-user data isolation via token prefix dirs
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, readJSON, writeJSON, log } from "./storage.js";

const TOKENS_FILE = join(DATA_DIR, "tokens.json");

interface TokenRecord {
  name: string;
  created_at: string;
  last_active: string;
  is_default?: boolean;
}

type TokenStore = Record<string, TokenRecord>;

function loadTokens(): TokenStore {
  return readJSON<TokenStore>(TOKENS_FILE, {});
}

function saveTokens(tokens: TokenStore): void {
  writeJSON(TOKENS_FILE, tokens);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// ── Public API ───────────────────────────────────────────────

export interface RegisterResult {
  token: string;
  name: string;
  created_at: string;
  is_new: boolean;
  is_default: boolean;
}

export function registerUser(name = ""): RegisterResult {
  const tokens = loadTokens();

  // Check for existing user with same name
  if (name) {
    const normalized = normalizeName(name);
    for (const [tok, info] of Object.entries(tokens)) {
      if (normalizeName(info.name) === normalized) {
        log(`ℹ️  User exists: ${name} → ${tok.slice(0, 8)}...`);
        return { token: tok, name: info.name, created_at: info.created_at, is_new: false, is_default: !!info.is_default };
      }
    }
  }

  // First token ever → auto-set as default
  const isFirstToken = Object.keys(tokens).length === 0;

  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  tokens[token] = { name, created_at: now, last_active: now, is_default: isFirstToken };
  saveTokens(tokens);

  log(`✅ New user: ${name || "(unnamed)"} → ${token.slice(0, 8)}...${isFirstToken ? " (default)" : ""}`);
  return { token, name, created_at: now, is_new: true, is_default: isFirstToken };
}

export function verifyToken(token: string): TokenRecord | null {
  const tokens = loadTokens();
  if (!(token in tokens)) return null;
  tokens[token].last_active = new Date().toISOString();
  saveTokens(tokens);
  return tokens[token];
}

export function resolveToken(tokenOrName: string): string | null {
  const input = tokenOrName.trim();
  const tokens = loadTokens();

  // If input is empty, try default fallback
  if (!input) {
    return resolveDefault();
  }

  // Direct token match
  if (input in tokens) return input;

  // Name lookup (case-insensitive)
  const normalized = normalizeName(input);
  for (const [tok, info] of Object.entries(tokens)) {
    if (normalizeName(info.name) === normalized) return tok;
  }

  return null;
}

/**
 * Find the default token. Fallback: if only one token exists, treat it as default.
 */
export function resolveDefault(): string | null {
  const tokens = loadTokens();
  const entries = Object.entries(tokens);
  if (entries.length === 0) return null;

  // Look for explicit is_default=true
  for (const [tok, info] of entries) {
    if (info.is_default) return tok;
  }

  // Implicit fallback: single token → treat as default (no write needed)
  if (entries.length === 1) return entries[0][0];

  // Multiple tokens, none marked default
  return null;
}

/**
 * Get the name of the current default user (for error messages).
 */
export function getDefaultName(): string | null {
  const tok = resolveDefault();
  if (!tok) return null;
  const tokens = loadTokens();
  return tokens[tok]?.name || null;
}

/**
 * Set a token as the default identity.
 */
/**
 * Return all registered token strings.
 */
export function getAllTokens(): string[] {
  return Object.keys(loadTokens());
}

export function setDefault(tokenOrName: string): { success: boolean; name: string; error?: string } {
  const resolved = resolveToken(tokenOrName);
  if (!resolved) {
    return { success: false, name: "", error: `找不到用户 "${tokenOrName}"。请检查用户名或token。` };
  }

  const tokens = loadTokens();

  // Clear all defaults
  for (const info of Object.values(tokens)) {
    info.is_default = false;
  }

  // Set new default
  tokens[resolved].is_default = true;
  saveTokens(tokens);

  const name = tokens[resolved].name;
  log(`🔄 Default identity → ${name || "(unnamed)"}`);
  return { success: true, name };
}
