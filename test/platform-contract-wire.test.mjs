// The wire, for the contract turn and kb sync: the real commands driven through
// a fake `fetch`, so what is asserted is the exact request the CLI makes —
// method, path, headers, body — and the accounting it does with the reply.
// No network, no config file (the key + base URL come from the env).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as chat } from "../src/commands/chat.mjs";
import { run as kb, hashContent } from "../src/commands/kb.mjs";
import { run as listen } from "../src/commands/listen.mjs";

const BASE = "http://gw.test/bot";

/**
 * Stub `fetch`, recording every request. `answer(req)` picks the reply. Also
 * captures stdout so `--json` output can be parsed back. Restores everything.
 */
async function wired(answer, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realWrite = process.stdout.write;
  const env = { key: process.env.WHISSLE_API_KEY, base: process.env.WHISSLE_BASE_URL };
  process.env.WHISSLE_API_KEY = "wsk_test";
  process.env.WHISSLE_BASE_URL = BASE;
  let stdout = "";
  // Only STRING writes are the CLI's. The test runner itself ships its own
  // (binary) protocol frames through process.stdout — those pass straight through.
  process.stdout.write = (s, ...rest) => {
    if (typeof s === "string") { stdout += s; return true; }
    return realWrite.call(process.stdout, s, ...rest);
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const req = {
      method: init.method || "GET",
      path: u.pathname.replace(/^\/bot/, ""),
      query: Object.fromEntries(u.searchParams),
      headers: init.headers || {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null,
    };
    calls.push(req);
    const r = answer(req) || {};
    if (r.sse) {
      return new Response(new Blob([r.sse]).stream(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status || 200, headers: { "content-type": "application/json" },
    });
  };
  try {
    await fn(calls);
    return { calls, stdout };
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realWrite;
    process.env.WHISSLE_API_KEY = env.key ?? "";
    process.env.WHISSLE_BASE_URL = env.base ?? "";
    if (env.key === undefined) delete process.env.WHISSLE_API_KEY;
    if (env.base === undefined) delete process.env.WHISSLE_BASE_URL;
  }
}

const TURN = {
  reply: "The cert is PSA-12345.",
  conversation_id: "c1",
  structured: { certId: "PSA-12345" },
  schema_error: null,
  claims: [{ text: "cert PSA-12345", chunk_id: "kbc_1", doc_id: "kbd_1", doc_version: 2, score: 0.9 }],
  retrieved: [{ chunk_id: "kbc_1", doc_id: "kbd_1", doc_version: 2, score: 0.8, text: "…" }],
  model_tier: "default",
  trace_id: "trc_1",
  tools_used: [],
  evidence: [],
};

test("chat turn --schema --cite --facts --cost-center --on-behalf-of: the body and the header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-turn-"));
  try {
    const schema = join(dir, "s.json");
    writeFileSync(schema, JSON.stringify({ type: "object", properties: { certId: { type: "string" } }, required: ["certId"] }));
    const { calls, stdout } = await wired(
      (req) => (req.path === "/api/agents/a1" ? { body: { id: "a1", name: "Grader" } } : { body: TURN }),
      () => chat("turn", ["a1"], {
        m: "which cert?", schema, cite: true, facts: ["listing.certId=PSA-12345"], "cost-center": "sidestage:show_1",
        "model-tier": "fast", "on-behalf-of": "seller_9", context: "live: lot 4", json: true,
      }),
    );
    const turn = calls.find((c) => c.path === "/api/agents/a1/chat/turn");
    assert.ok(turn, "no turn was posted");
    assert.equal(turn.method, "POST");
    assert.equal(turn.headers.Authorization, "Bearer wsk_test");
    assert.equal(turn.headers["X-Whissle-On-Behalf-Of"], "seller_9");
    assert.deepEqual(turn.body.response_schema.required, ["certId"]);
    assert.equal(turn.body.cite, true);
    assert.deepEqual(turn.body.facts, { "listing.certId": "PSA-12345" });
    assert.equal(turn.body.cost_center, "sidestage:show_1");
    assert.equal(turn.body.model_tier, "fast");
    assert.equal(turn.body.context, "live: lot 4");
    assert.equal(turn.body.message, "which cert?");
    assert.equal(turn.body.source, "cli");
    assert.equal("subject" in turn.body, false);
    // --json prints the payload verbatim, and nothing else.
    assert.deepEqual(JSON.parse(stdout), TURN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain turn sends no header and none of the contract fields", async () => {
  const { calls } = await wired(
    (req) => (req.path === "/api/agents/a1" ? { body: { id: "a1", name: "x" } } : { body: { reply: "hi", conversation_id: "c1" } }),
    () => chat("a1", [], { m: "hi", json: true }),
  );
  const turn = calls.find((c) => c.path === "/api/agents/a1/chat/turn");
  assert.equal("X-Whissle-On-Behalf-Of" in turn.headers, false);
  assert.deepEqual(Object.keys(turn.body).sort(), ["message", "session_id", "source"]);
});

test("chat turn --stream drives the stream door and takes the payload from `done`", async () => {
  const sse =
    'event: open\ndata: {"conversation_id":"c1"}\n\n' +
    'event: delta\ndata: {"hop":0,"text":"Let me check."}\n\n' +
    'event: tool\ndata: {"phase":"result","function_name":"search_knowledge_base","ok":true,"result":{"evidence":[{"title":"x"}]}}\n\n' +
    'event: delta\ndata: {"hop":1,"text":"PSA-12345."}\n\n' +
    `event: done\ndata: ${JSON.stringify({ ...TURN, reply: "PSA-12345." })}\n\n`;
  const { calls, stdout } = await wired(
    (req) => (req.path === "/api/agents/a1" ? { body: { id: "a1" } } : { sse }),
    () => chat("turn", ["a1"], { m: "cert?", stream: true, cite: true, "on-behalf-of": "u1", json: true }),
  );
  const s = calls.find((c) => c.path === "/api/agents/a1/chat/turn/stream");
  assert.ok(s, "the stream door was not used");
  assert.equal(s.method, "POST");
  assert.equal(s.headers.Accept, "text/event-stream");
  assert.equal(s.headers["X-Whissle-On-Behalf-Of"], "u1");
  assert.equal(s.body.cite, true);
  const payload = JSON.parse(stdout);
  assert.equal(payload.reply, "PSA-12345.");
  assert.equal(payload.trace_id, "trc_1");
});

test("a 413 for an over-long context is reported with the limit, exit 1", async () => {
  const realExit = process.exit;
  const realErr = process.stderr.write;
  let stderr = "", code = null;
  process.exit = (c) => { code = c; throw new Error("exit"); };
  process.stderr.write = (s) => { stderr += s; return true; };
  try {
    await assert.rejects(() => wired(
      (req) => (req.path === "/api/agents/a1" ? { body: { id: "a1" } } : { status: 413, body: { error: "context too long", max_chars: 32000, got: 40000 } }),
      () => chat("turn", ["a1"], { m: "hi", context: "x", json: true }),
    ));
  } finally {
    process.exit = realExit;
    process.stderr.write = realErr;
  }
  assert.equal(code, 1);
  assert.match(stderr, /40000/);
  assert.match(stderr, /32000/);
});

test("kb sync PUTs each file by path with its content_hash and accounts for the replies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-sync-"));
  try {
    mkdirSync(join(dir, "faq"));
    writeFileSync(join(dir, "faq", "hours.md"), "# Opening hours\n9–5");
    writeFileSync(join(dir, "prices.csv"), "sku,usd\nA,10");
    writeFileSync(join(dir, "logo.png"), "not synced");
    const replies = {
      "/api/agents/a1/kb/docs/faq%2Fhours.md": { unchanged: true },
      "/api/agents/a1/kb/docs/prices.csv": { doc_id: "kbd_2", doc_version: 1 },
    };
    const { calls, stdout } = await wired(
      (req) => {
        if (req.method === "GET" && req.path === "/api/agents/a1/kb/docs") {
          return { body: [{ doc_id: "kbd_1", external_id: "faq/hours.md" }, { doc_id: "kbd_9", external_id: "stale.md" }] };
        }
        return { body: replies[req.path] ?? {} };
      },
      () => kb("sync", ["a1", dir], { namespace: "site", prune: true, json: true }),
    );
    const list = calls[0];
    assert.equal(list.method, "GET");
    assert.equal(list.path, "/api/agents/a1/kb/docs");
    assert.deepEqual(list.query, { namespace: "site" });
    const puts = calls.filter((c) => c.method === "PUT");
    assert.deepEqual(puts.map((c) => c.path), ["/api/agents/a1/kb/docs/faq%2Fhours.md", "/api/agents/a1/kb/docs/prices.csv"]);
    assert.deepEqual(puts[0].body, {
      title: "Opening hours",
      content: "# Opening hours\n9–5",
      mime: "text/markdown",
      namespace: "site",
      content_hash: hashContent(Buffer.from("# Opening hours\n9–5")),
    });
    assert.equal(puts[1].body.content_hash, hashContent(Buffer.from("sku,usd\nA,10")));
    const dels = calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(dels.map((c) => c.path), ["/api/agents/a1/kb/docs/stale.md"]);
    assert.deepEqual(JSON.parse(stdout), { agent_id: "a1", namespace: "site", added: 1, updated: 0, unchanged: 1, removed: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kb sync --dry-run sends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-sync-"));
  try {
    writeFileSync(join(dir, "a.md"), "# A");
    const { calls, stdout } = await wired(() => ({ body: {} }), () => kb("sync", ["a1", dir], { "dry-run": true, json: true }));
    assert.deepEqual(calls, []);
    const plan = JSON.parse(stdout);
    assert.equal(plan.dry_run, true);
    assert.deepEqual(plan.puts.map((p) => p.external_id), ["a.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kb eval posts the cases and kb search asks the search route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-eval-"));
  try {
    const labels = join(dir, "labels.json");
    writeFileSync(labels, JSON.stringify([{ question: "hours?", expected_doc_id: "kbd_1" }]));
    const { calls } = await wired(
      () => ({ body: { recall_at_1: 1, recall_at_3: 1, recall_at_5: 1, mrr: 1, cases: [] } }),
      async () => {
        await kb("eval", ["a1", labels], { k: "3", json: true });
        await kb("search", ["a1", "opening", "hours"], { k: "2", namespace: "site", json: true });
      },
    );
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/agents/a1/kb/eval");
    assert.deepEqual(calls[0].body, { cases: [{ question: "hours?", expected_doc_id: "kbd_1" }], k: 3 });
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].path, "/api/agents/a1/kb/search");
    assert.deepEqual(calls[1].query, { q: "opening hours", k: "2", namespace: "site" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listen start posts to the listen door and answers the room descriptor", async () => {
  const { calls, stdout } = await wired(
    () => ({ body: { url: "wss://lk.test", token: "t", room: "r", session_id: "sess_1" } }),
    () => listen("start", ["a1"], { language: "en", json: true }),
  );
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/agents/a1/listen/start");
  assert.deepEqual(calls[0].body, { language: "en" });
  assert.equal(JSON.parse(stdout).session_id, "sess_1");
});

test("listen tail --once polls the session once and prints NDJSON rows with their turn_id", async () => {
  const { calls, stdout } = await wired(
    () => ({ body: { id: "sess_1", status: "active", transcript: [{ role: "user", content: "hi", turn_id: "t1" }], signals: [{ turn_id: "t1", words_per_minute: 120 }] } }),
    () => listen("tail", ["sess_1"], { once: true, json: true }),
  );
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", "/api/sessions/sess_1"]]);
  const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["transcript", "signal"]);
  assert.equal(lines[0].turn_id, "t1");
  assert.equal(lines[1].words_per_minute, 120);
});
