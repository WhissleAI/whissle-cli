// `whissle chat` writes REAL history. These pin the two fields that decide
// whether that history is legible in the studio, and the link that tells the
// user where to find it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { describeAgent, newSessionId, turnBody, sessionsUrl } from "../src/commands/chat.mjs";
import { EP } from "../src/endpoints.mjs";

test("a turn declares itself as the CLI", () => {
  // Without this the studio files a CLI run, an n8n step and a partner backend
  // identically — same org key, same endpoint, no way to tell them apart.
  assert.equal(turnBody({ message: "hi", sessionId: "s1" }).source, "cli");
});

test("the first turn opens a thread of its own", () => {
  const b = turnBody({ message: "hi", sessionId: "s1" });
  assert.equal(b.session_id, "s1");
  assert.equal("conversation_id" in b, false);
});

test("later turns thread on the server's conversation id", () => {
  const b = turnBody({ message: "hi", conversationId: "c1", sessionId: "s1" });
  assert.equal(b.conversation_id, "c1");
});

test("each run gets a distinct session key", () => {
  assert.notEqual(newSessionId(), newSessionId());
});

test("the body carries nothing else", () => {
  assert.deepEqual(
    Object.keys(turnBody({ message: "hi", conversationId: "c1", sessionId: "s1" })).sort(),
    ["conversation_id", "message", "session_id", "source"],
  );
});

test("it points at the agent's Sessions tab", () => {
  assert.equal(
    sessionsUrl("https://whissle.ai", "abc"),
    "https://whissle.ai/agents/abc/calls",
  );
  // A self-hosted studioUrl with a trailing slash must not double it.
  assert.equal(sessionsUrl("https://studio.local/", "abc"), "https://studio.local/agents/abc/calls");
});

test("it still drives the persisted endpoint, not a stateless one", () => {
  // /api/bench/agent-turn is deliberately stateless and persists nothing; a CLI
  // conversation that used it would leave no history at all.
  assert.equal(EP.agents.chatTurn("abc"), "/api/agents/abc/chat/turn");
});

// ── the preflight that made `agents:read` a hidden requirement for chatting ──

test("chat survives an agent lookup it is not allowed to make", async () => {
  // The old code did GET /api/agents/{id} and fatal()'d on ANY failure, so a key
  // scoped exactly `chat:invoke` — the correct least-privilege key for a bot
  // that only talks — could not chat, and the error said "Agent not found",
  // which is the one thing that was not wrong.
  const a = await describeAgent("abc", async () => {
    const e = new Error("403 missing scope");
    e.status = 403;
    throw e;
  });
  assert.equal(a.known, false);
  assert.equal(a.id, "abc");
  assert.equal(a.name, "abc"); // the id stands in for a name we could not read
});

test("a readable agent still supplies its name and greeting", async () => {
  const a = await describeAgent("abc", async () => ({ id: "abc", name: "Support", greeting: "hi" }));
  assert.equal(a.known, true);
  assert.equal(a.name, "Support");
  assert.equal(a.greeting, "hi");
});

test("an empty agent body is treated as unreadable, not as a nameless agent", async () => {
  assert.equal((await describeAgent("abc", async () => null)).known, false);
});

// ── the session key must survive a resume ────────────────────────────────────

test("a resumed turn carries BOTH handles", () => {
  // Not contradictory, and the asymmetry is the server's: `conversation_id` is
  // looked up first and wins outright when it resolves, so `session_id` is
  // simply not read on that branch. It IS read on the other branch — the one a
  // stale, mistyped or foreign `--conversation` falls onto, because the server
  // declines to adopt an id it cannot resolve and opens a thread instead.
  //
  // Withholding the session key there (what the one-shot path used to do) is
  // what dropped that turn into `key:<api-key-id>` — the single ever-growing
  // per-key thread `session_id` exists to prevent.
  const b = turnBody({ message: "and?", conversationId: "c1", sessionId: "s1" });
  assert.equal(b.conversation_id, "c1");
  assert.equal(b.session_id, "s1");
});

test("the one-shot path sends the session key even when resuming", async () => {
  // The regression this pins is invisible in `turnBody` alone — it was the CALL
  // SITE that passed `sessionId: conversationId ? null : sessionId`.
  const src = await readFile(new URL("../src/commands/chat.mjs", import.meta.url), "utf8");
  assert.equal(
    /sessionId:\s*conversationId\s*\?/.test(src),
    false,
    "chat.mjs must not withhold the session key on a resumed turn",
  );
  // Both call sites (one-shot and REPL — `message:` with a value, as against the
  // declaration's bare `message,`) pass the same handles through, unconditionally.
  const callSites = src.match(/turnBody\(\{ message: [^}]*\}\)/g) || [];
  assert.equal(callSites.length, 2, `expected 2 turnBody call sites, saw ${callSites.length}`);
  for (const site of callSites) assert.match(site, /conversationId,\s*sessionId\s*\}/);
});

test("the session key is short enough for the column that stores it", () => {
  // `ChatTurnBody.session_id` is `Field(default=None, max_length=64)`; a longer
  // one is a 422, not a truncation.
  assert.ok(newSessionId().length <= 64);
});
