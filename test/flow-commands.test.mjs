// Unit tests for the new flow-authoring + discovery commands (node:test, no network).
// These lock the PATH/METHOD/BODY construction the commands rely on, the `flow`
// file-passthrough regression, and the shared arg parser — all pure, no fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { EP } from "../src/endpoints.mjs";
import { pick, unwrapFlow, FILE_PATCH_FIELDS } from "../src/commands/agents.mjs";
import { parse } from "../bin/whissle.mjs";

// ── endpoint paths (single source of truth → the real backend routes) ────────

test("agents flow endpoints resolve to the backend paths", () => {
  const id = "a1";
  assert.equal(EP.agents.update(id), "/api/agents/a1");            // PATCH {flow} (+ ?target)
  assert.equal(EP.agents.flowGenerate(id), "/api/agents/a1/flow/generate");
  assert.equal(EP.agents.flowTrace(id), "/api/agents/a1/flow/trace");
  assert.equal(EP.agents.publish(id), "/api/agents/a1/publish");
  assert.equal(EP.agents.discardDraft(id), "/api/agents/a1/draft/discard");
  assert.equal(EP.agents.workflow(id), "/api/agents/a1/workflow");
  assert.equal(EP.agents.guardrails(id), "/api/agents/a1/guardrails");
});

test("discovery + org-scoped CRUD endpoints resolve correctly", () => {
  assert.equal(EP.models.voices, "/api/models/voices");
  assert.equal(EP.agentTypes, "/api/agent-types");
  assert.equal(EP.tools.update("o", "t"), "/api/orgs/o/tools/t");
  assert.equal(EP.tools.del("o", "t"), "/api/orgs/o/tools/t");
  assert.equal(EP.connectors.update("o", "c"), "/api/orgs/o/credentials/c");
  assert.equal(EP.connectors.test("o", "c"), "/api/orgs/o/credentials/c/test");
  assert.equal(EP.wallet.base("o"), "/api/orgs/o/wallet");
  assert.equal(EP.wallet.ledger("o"), "/api/orgs/o/wallet/ledger");
});

// ── the `flow` passthrough fix (task 2 regression guard) ─────────────────────

test("FILE_PATCH_FIELDS carries `flow` so a file-based patch keeps it", () => {
  assert.ok(FILE_PATCH_FIELDS.includes("flow"), "flow must be a passthrough field");
});

test("pick() preserves a flow key from an agent file (was silently dropped)", () => {
  const spec = {
    name: "Intake",
    system_prompt: "…",
    flow: { version: 1, start_state: "greet", states: [{ id: "greet", type: "say" }] },
    ignored_extra: true,
  };
  const body = pick(spec, FILE_PATCH_FIELDS);
  assert.deepEqual(body.flow, spec.flow);
  assert.equal(body.ignored_extra, undefined); // non-whitelisted keys still stripped
});

// ── `flow set --file` body normalization ─────────────────────────────────────

test("unwrapFlow accepts a bare flow object", () => {
  const bare = { version: 1, start_state: "greet", states: [{ id: "greet" }] };
  assert.deepEqual(unwrapFlow(bare), bare);
});

test("unwrapFlow unwraps a { flow: {...} } wrapper", () => {
  const inner = { version: 1, start_state: "greet", states: [{ id: "greet" }] };
  assert.deepEqual(unwrapFlow({ flow: inner }), inner);
});

test("unwrapFlow leaves a wrapper-shaped-but-real flow alone when it has states", () => {
  // A real flow that happens to carry a `flow` sub-key must NOT be unwrapped —
  // presence of top-level `states` marks it as the flow itself.
  const real = { version: 1, states: [{ id: "s" }], flow: { nope: true } };
  assert.deepEqual(unwrapFlow(real), real);
});

// ── arg parsing for the new commands ─────────────────────────────────────────

test("parse() reads the flow-set draft + file flags", () => {
  const { positionals, flags } = parse(["flow", "set", "a1", "--file", "flow.json", "--draft"]);
  assert.deepEqual(positionals, ["flow", "set", "a1"]);
  assert.equal(flags.file, "flow.json");
  assert.equal(flags.draft, true); // boolean flag (no value follows)
});

test("parse() reads flow show --draft", () => {
  const { positionals, flags } = parse(["flow", "show", "a1", "--draft", "--json"]);
  assert.deepEqual(positionals, ["flow", "show", "a1"]);
  assert.equal(flags.draft, true);
  assert.equal(flags.json, true);
});

test("parse() reads flow generate --goal and flow trace --conversation", () => {
  const gen = parse(["flow", "generate", "a1", "--goal", "verify policy first"]);
  assert.equal(gen.flags.goal, "verify policy first");

  const tr = parse(["flow", "trace", "a1", "--conversation", "conv_123"]);
  assert.equal(tr.flags.conversation, "conv_123");
  assert.deepEqual(tr.positionals, ["flow", "trace", "a1"]);
});
