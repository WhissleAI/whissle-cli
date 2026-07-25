// The Whissle gateway REST client. Thin wrapper over fetch with bearer auth,
// JSON + multipart bodies, consistent error surfacing, and org resolution.
//
// This module is deliberately self-contained (no CLI-specific imports) so it can
// later be lifted verbatim into a published @whissle/sdk package — the CLI is
// just its first consumer.

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig, saveConfig } from "./config.mjs";

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function authHeader(cfg) {
  if (!cfg.apiKey) {
    throw new ApiError(
      0,
      "No API key configured. Run `whissle login` (or set WHISSLE_API_KEY) with a workspace secret key from Settings → API keys.",
    );
  }
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

async function parse(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function fail(res, body) {
  const detail =
    (body && typeof body === "object" && (body.detail || body.error || body.message)) ||
    (typeof body === "string" && body) ||
    res.statusText;
  let msg = `${res.status} ${detail}`;
  if (res.status === 401) msg += "  (check your key — `whissle login`)";
  if (res.status === 402) msg += "  (workspace out of credit — top up in Settings → Billing)";
  if (res.status === 403) msg += "  (your key lacks the required scope for this action)";
  throw new ApiError(res.status, msg, body);
}

/** Core JSON request. `query` is an object of string params; `body` is JSON. */
export async function request(method, path, { query, body, cfg = loadConfig() } = {}) {
  const url = new URL(cfg.baseUrl + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeader(cfg),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const parsed = await parse(res);
  if (!res.ok) fail(res, parsed);
  return parsed;
}

export const get = (path, opts) => request("GET", path, opts);
export const post = (path, body, opts) => request("POST", path, { ...opts, body });
export const patch = (path, body, opts) => request("PATCH", path, { ...opts, body });
export const del = (path, opts) => request("DELETE", path, opts);

/** Multipart upload (KB files, transcribe audio). `fields` are string form parts. */
export async function upload(path, { filePath, fileField = "file", fields = {}, cfg = loadConfig() } = {}) {
  statSync(filePath); // throws a clear ENOENT if the file is missing
  const form = new FormData();
  const bytes = readFileSync(filePath);
  form.set(fileField, new Blob([bytes]), basename(filePath));
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, String(v));
  const res = await fetch(cfg.baseUrl + path, { method: "POST", headers: authHeader(cfg), body: form });
  const parsed = await parse(res);
  if (!res.ok) fail(res, parsed);
  return parsed;
}

/** Raw response (for binary bodies like TTS audio). Returns the Response. */
export async function raw(method, path, { body, cfg = loadConfig() } = {}) {
  const res = await fetch(cfg.baseUrl + path, {
    method,
    headers: { ...authHeader(cfg), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) fail(res, await parse(res));
  return res;
}

/**
 * The workspace id for the key. Endpoints under /api/orgs/{org} (tools, wallet)
 * need it; agents/calls/kb/models resolve the org from the key server-side. A
 * secret key belongs to exactly one workspace, so we resolve it once and cache it.
 */
export async function resolveOrgId(cfg = loadConfig()) {
  if (cfg.orgId) return cfg.orgId;
  const me = await whoami(cfg);
  const id = me?.organization?.id;
  if (!id) throw new ApiError(0, "Could not resolve a workspace for this key.");
  saveConfig({ orgId: id });
  return id;
}

/** The caller's workspace + role for this key (GET /api/whoami). */
export async function whoami(cfg = loadConfig()) {
  return get("/api/whoami", { cfg });
}
