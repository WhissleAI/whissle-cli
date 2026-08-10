// Unit tests for `embed token` request shaping (node:test, no network).
// The mint is a PUBLIC route: it reads the credential from the BODY as
// `api_key`, not from the bearer header alone. Getting that wrong 400s with
// "embed_key or api_key required", so pin it.
import test from "node:test";
import assert from "node:assert/strict";
import { sessionBody, openUrls } from "../src/commands/embed.mjs";
import { EP } from "../src/endpoints.mjs";

test("the credential travels in the body as api_key", () => {
  const body = sessionBody({ apiKey: "wsk_live_abc" }, "agent-1");
  assert.equal(body.api_key, "wsk_live_abc");
  assert.equal(body.agent_id, "agent-1");
});

test("no parent_origin is sent — a secret-key mint is server-trusted", () => {
  // Sending an origin would bind the token to it, defeating the whole point of
  // the server-side mint (the partner would have to allowlist an origin here).
  const body = sessionBody({ apiKey: "wsk_live_abc" }, "agent-1");
  assert.equal("parent_origin" in body, false);
  assert.equal("embed_key" in body, false);
});

test("open URLs are absolute and carry no token", () => {
  const urls = openUrls("https://aws-gateway-backend.whissle.ai/bot");
  assert.equal(urls.voice, "https://aws-gateway-backend.whissle.ai/bot/api/embed/offer");
  assert.equal(urls.text, "https://aws-gateway-backend.whissle.ai/bot/api/embed/chat/turn");
});

test("the embed session paths are the public ones, not the agent config path", () => {
  // agents.embed is the CONFIG (enable the widget); embed.* is the RUNTIME.
  assert.equal(EP.agents.embed("a1"), "/api/agents/a1/embed");
  assert.equal(EP.embed.sessionToken, "/api/embed/session-token");
  assert.equal(EP.embed.simliToken, "/api/embed/simli-token");
});
