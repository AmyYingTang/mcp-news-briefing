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
}

export function registerUser(name = ""): RegisterResult {
  const tokens = loadTokens();

  // Check for existing user with same name
  if (name) {
    const normalized = normalizeName(name);
    for (const [tok, info] of Object.entries(tokens)) {
      if (normalizeName(info.name) === normalized) {
        log(`ℹ️  User exists: ${name} → ${tok.slice(0, 8)}...`);
        return { token: tok, name: info.name, created_at: info.created_at, is_new: false };
      }
    }
  }

  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  tokens[token] = { name, created_at: now, last_active: now };
  saveTokens(tokens);

  log(`✅ New user: ${name || "(unnamed)"} → ${token.slice(0, 8)}...`);
  return { token, name, created_at: now, is_new: true };
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

  // Direct token match
  if (input in tokens) return input;

  // Name lookup (case-insensitive)
  const normalized = normalizeName(input);
  for (const [tok, info] of Object.entries(tokens)) {
    if (normalizeName(info.name) === normalized) return tok;
  }

  return null;
}
