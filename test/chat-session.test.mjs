// `whissle chat` writes REAL history. These pin the two fields that decide
// whether that history is legible in the studio, and the link that tells the
// user where to find it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { newSessionId, turnBody, sessionsUrl } from "../src/commands/chat.mjs";
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
    sessionsUrl("https://platform.whissle.ai", "abc"),
    "https://platform.whissle.ai/agents/abc/calls",
  );
  // A self-hosted studioUrl with a trailing slash must not double it.
  assert.equal(sessionsUrl("https://studio.local/", "abc"), "https://studio.local/agents/abc/calls");
});

test("it still drives the persisted endpoint, not a stateless one", () => {
  // /api/bench/agent-turn is deliberately stateless and persists nothing; a CLI
  // conversation that used it would leave no history at all.
  assert.equal(EP.agents.chatTurn("abc"), "/api/agents/abc/chat/turn");
});
