// `whissle chat` writes REAL history. These pin the two fields that decide
// whether that history is legible in the studio, and the link that tells the
// user where to find it.
import { test } from "node:test";
import assert from "node:assert/strict";

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

test("a resumed one-shot addresses the thread and drops the opening session key", () => {
  // Both together is contradictory: session_id is what NAMES a new session row,
  // and a resumed turn is not opening one.
  const b = turnBody({ message: "and?", conversationId: "c1", sessionId: null });
  assert.equal(b.conversation_id, "c1");
  assert.equal("session_id" in b, false);
});
