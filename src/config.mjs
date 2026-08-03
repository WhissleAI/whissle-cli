// Config resolution for the Whissle CLI.
//
// Precedence (highest first): CLI flags → environment → ~/.whissle/config.json →
// built-in defaults. The API key is a workspace SECRET key (wsk_…) created in
// Settings → API keys on platform.whissle.ai. It is stored locally in
// ~/.whissle/config.json with 0600 perms — treat it like an SSH key.

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";

export const DEFAULT_BASE_URL = "https://aws-gateway-backend.whissle.ai/bot";

const DIR = join(homedir(), ".whissle");
const FILE = join(DIR, "config.json");

function readFile() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Persist a partial config, merged over what's on disk. Never widens perms. */
export function saveConfig(patch) {
  mkdirSync(DIR, { recursive: true });
  const next = { ...readFile(), ...patch };
  writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  return next;
}

/** The effective config, applying env overrides over the stored file. */
export function loadConfig() {
  const file = readFile();
  return {
    apiKey: process.env.WHISSLE_API_KEY || file.apiKey || null,
    baseUrl:
      (process.env.WHISSLE_BASE_URL || file.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    // Cached org id (resolved from the key on first use) to save a round-trip.
    orgId: file.orgId || null,
  };
}

export const configPath = FILE;
export const configExists = () => existsSync(FILE);
