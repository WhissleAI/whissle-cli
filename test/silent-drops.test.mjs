// Fields the CLI sent that the gateway never read (node:test, no network).
//
// FastAPI/pydantic models ignore keys they do not declare. So a CLI flag mapped
// onto a field the handler's body model lacks does not 422 — it succeeds, and
// the caller is told the thing they asked for happened. Four of those shipped:
//
//   • `sms send --from`      → `from_number`, absent from `SmsSendBody`
//   • `alerts rules --webhook` → `webhook_id`, absent from `RuleBody`/`RulePatch`
//   • `alerts rules update --kind/--door` → absent from `RulePatch` only
//   • `kb add --file --title` → `upload_kb` takes `file` and nothing else
//
// Each is verified against the handler in
// whissle_gateway_backend/pipecat-bot/routes/. This file pins the corrected
// behaviour so none of them can quietly come back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "../bin/whissle.mjs";
import { sendBody } from "../src/commands/sms.mjs";
import { RULE_FLAGS, CREATE_ONLY_FIELDS, ruleBody, kindRuleBody } from "../src/commands/alerts.mjs";
import { EVENT_KINDS, webhookBody } from "../src/commands/webhooks.mjs";
import { EP } from "../src/endpoints.mjs";

const src = (f) => readFile(new URL(`../src/${f}`, import.meta.url), "utf8");

/** Run `fn` with `process.exit` turned into a throw, so a `fatal()` is assertable. */
function exits(fn) {
  const real = process.exit;
  const realErr = process.stderr.write;
  process.exit = (code) => { throw new Error(`exit ${code}`); };
  process.stderr.write = () => true;
  try { return fn(); }
  finally { process.exit = real; process.stderr.write = realErr; }
}

// ── sms: SmsSendBody is to_number + body + agent_id ─────────────────────────

test("no sms body ever carries a from_number", () => {
  for (const flags of [
    { to: "+1", body: "b" },
    { to: "+1", body: "b", from: "+15550000000" },
    { to: "+1", body: "b", from: "+15550000000", agent: "a1" },
  ]) {
    assert.ok(!("from_number" in sendBody(flags)), "from_number is not a field the route has");
  }
  assert.deepEqual(Object.keys(sendBody({ to: "+1", body: "b", from: "+1", agent: "a1" })), ["to_number", "body", "agent_id"]);
});

test("passing --from is said out loud rather than swallowed", async () => {
  const s = await src("commands/sms.mjs");
  assert.match(s, /if \(flags\.from\) warn\(/, "sms send must warn that --from cannot be honoured");
});

// ── alerts: no per-rule webhook target, and kind/door are create-only ───────

test("no alert rule body carries a webhook_id", () => {
  // A firing calls webhooks.emit(org, event, …) (services/alerts.py
  // `_emit_event`) — it fans out to every endpoint in the workspace subscribed
  // to that event. There is no field for targeting one, in either body model.
  assert.ok(!("webhook" in RULE_FLAGS), "--webhook maps to nothing the gateway reads");
  for (const flags of [
    { name: "n", metric: "completion_rate", threshold: "0.6", webhook: "w1" },
    { kind: "balance_below_usd", threshold: "20", webhook: "w1" },
  ]) {
    assert.ok(!("webhook_id" in ruleBody(flags)));
  }
  assert.ok(!("webhook_id" in kindRuleBody({ kind: "balance_below_usd", threshold: "20", webhook: "w1" })));
});

test("kind and door are create-only, and an edit of them is refused", async () => {
  // `RuleBody` takes kind + door; `RulePatch` does not. A PUT carrying them
  // answers 200 with the rule unchanged, which reads exactly like a successful
  // edit — so the CLI refuses instead, and names the remedy.
  assert.deepEqual(CREATE_ONLY_FIELDS, ["kind", "door"]);
  const s = await src("commands/alerts.mjs");
  const update = s.slice(s.indexOf('if (verb === "update")'));
  assert.match(update, /CREATE_ONLY_FIELDS\.filter/, "rules update must screen the create-only fields");
  assert.match(update, /delete the rule and create it again/i, "the refusal must say how to change them");
  // They are still accepted on create, which is where they work.
  assert.equal(kindRuleBody({ kind: "p95_ms_over", door: "chat_turn", threshold: "1500" }).door, "chat_turn");
});

test("--kind and --door do reach a create body", () => {
  const { flags } = parse(["create", "--kind", "p95_ms_over", "--door", "chat_turn", "--threshold", "1500"]);
  const body = kindRuleBody(flags);
  assert.equal(body.kind, "p95_ms_over");
  assert.equal(body.door, "chat_turn");
  assert.equal(body.comparator, "above");
});

// ── kb: upload_kb titles the document from its filename ────────────────────

test("a file upload sends no title, and says why", async () => {
  const s = await src("commands/kb.mjs");
  const add = s.slice(s.indexOf('if (sub === "add")'));
  const upload = add.slice(0, add.indexOf("flags.text"));
  assert.doesNotMatch(upload, /fields:\s*\{\s*title/, "upload_kb takes `file` and nothing else");
  assert.match(upload, /if \(flags\.title\) warn\(/, "a --title on an upload must be reported, not dropped");
});

// ── webhooks: the vocabulary comes from the gateway ─────────────────────────

test("the event vocabulary has a path and is asked for, not assumed", async () => {
  assert.equal(EP.webhooks.events, "/api/webhooks/events");
  const s = await src("commands/webhooks.mjs");
  assert.match(s, /EP\.webhooks\.events/, "the CLI must read the live vocabulary");
  assert.match(s, /webhookBody\(flags, await liveVocabulary\(\)\)/, "create must validate against the live list");
});

test("webhookBody validates against whatever vocabulary it is handed", () => {
  // The built-in list is the OFFLINE fallback. Checking only against it is how
  // a CLI ends up unable to subscribe to an event the platform already emits.
  const live = [...EVENT_KINDS.map(([k]) => k), "call.recorded"];
  assert.deepEqual(webhookBody({ url: "https://e.example.com/h", events: "call.recorded" }, live), {
    url: "https://e.example.com/h",
    events: ["call.recorded"],
  });
  // …and an event in neither list is still refused here, naming the list.
  assert.throws(() => exits(() => webhookBody({ url: "https://e.example.com/h", events: "nope.nope" }, live)), /exit 1/);
});

test("the built-in fallback is still the documented six", () => {
  assert.deepEqual(EVENT_KINDS.map(([k]) => k), [
    "session.ended",
    "tool.held",
    "approval.decided",
    "kb.ingested",
    "balance.threshold",
    "latency.threshold",
  ]);
});
