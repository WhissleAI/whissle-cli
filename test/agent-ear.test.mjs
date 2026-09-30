// `whissle agents … --ear` — which engine decodes the words.
//
// The CLI could set an agent's voice, its language mode, its tools and its
// flow, and not the one thing that decides whether it HEARS the caller. An
// agent file could not describe its own ear either, so a spec that round-tripped
// through `agents create --file` silently lost it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { EARS, bodyFromFlags, CREATE_FIELDS } from "../src/commands/agents.mjs";

test("every ear the gateway accepts is offered here", () => {
  // models.STT_PROVIDERS on the gateway. A list that lags refuses a provider
  // the platform serves — the same failure `--engine` has.
  assert.deepEqual(EARS, ["deepgram", "sarvam", "whissle", "verbit"]);
});

test("--ear writes stt_provider", () => {
  assert.equal(bodyFromFlags({ ear: "verbit" }).stt_provider, "verbit");
  assert.equal(bodyFromFlags({ ear: " Deepgram " }).stt_provider, "deepgram");
});

test("omitting --ear sends no stt_provider, so the agent keeps what it had", () => {
  // An update that names only --prompt must not quietly rewrite the ear to a
  // default: PATCH bodies here are sparse on purpose.
  assert.equal(bodyFromFlags({}).stt_provider, undefined);
  assert.equal(bodyFromFlags({ prompt: "hi" }).stt_provider, undefined);
});

test("an agent FILE can carry the ear through create", () => {
  // `agents create --file` picks CREATE_FIELDS out of the spec. Without
  // stt_provider in that list the key was dropped between the file and the API.
  assert.ok(CREATE_FIELDS.includes("stt_provider"));
});
