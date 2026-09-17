// The 2026-09 platform-contract round (node:test, no network): listen, vision,
// versioned KB docs + eval, the contract turn fields, webhooks, attributed
// usage, alert kinds, and the long tail (bulk-approve/undo, sms send, numbers
// provision). Pure helpers + EP paths; the wire tests live in
// `platform-contract-wire.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EP } from "../src/endpoints.mjs";
import { parse, helpFor } from "../bin/whissle.mjs";
import { turnBody, turnOptions, parseFacts, explainTurnError, MODEL_TIERS } from "../src/commands/chat.mjs";
import { claimLines, contractFooterLines } from "../src/turn.mjs";
import { startBody, isEnded, diffTail, transcriptLine, signalLine } from "../src/commands/listen.mjs";
import { imageDataUrl, askBody, batchBody, BATCH_MAX } from "../src/commands/vision.mjs";
import { hashContent, titleOf, walkDir, planSync, applySync, evalBody, SYNC_EXTS } from "../src/commands/kb.mjs";
import { usageByQuery, USAGE_BY } from "../src/commands/usage.mjs";
import { latencyBits, turnLines } from "../src/commands/sessions.mjs";
import { webhookBody, EVENT_KINDS, SIGNATURE_SCHEME } from "../src/commands/webhooks.mjs";
import { ruleBody, kindRuleBody, ALERT_KINDS } from "../src/commands/alerts.mjs";
import { bulkIds, decisionHeaders } from "../src/commands/actions.mjs";
import { sendBody } from "../src/commands/sms.mjs";
import { firstCandidate } from "../src/commands/numbers.mjs";

const PLAIN = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Run `fn` with `process.exit` turned into a throw, so a `fatal()` is assertable. */
function exits(fn) {
  const real = process.exit;
  const realErr = process.stderr.write;
  process.exit = (code) => { throw new Error(`exit ${code}`); };
  process.stderr.write = () => true;
  try { return fn(); }
  finally { process.exit = real; process.stderr.write = realErr; }
}

// ── endpoint paths ───────────────────────────────────────────────────────────

test("contract endpoints resolve to the documented paths", () => {
  assert.equal(EP.agents.chatTurnStream("a1"), "/api/agents/a1/chat/turn/stream");
  assert.equal(EP.agents.chatBatch("a1"), "/api/agents/a1/chat/batch");
  assert.equal(EP.agents.kb.search("a1"), "/api/agents/a1/kb/search");
  assert.equal(EP.agents.kb.docs("a1"), "/api/agents/a1/kb/docs");
  assert.equal(EP.agents.kb.docByExternalId("a1", "faq%2Fhours.md"), "/api/agents/a1/kb/docs/faq%2Fhours.md");
  assert.equal(EP.agents.kb.eval("a1"), "/api/agents/a1/kb/eval");
  assert.equal(EP.agents.kb.ingest("a1"), "/api/agents/a1/kb/ingest");
  assert.equal(EP.agents.kb.ingestJob("a1", "j1"), "/api/agents/a1/kb/ingest/j1");
  assert.equal(EP.agents.listenStart("a1"), "/api/agents/a1/listen/start");
  assert.equal(EP.agents.vision("a1"), "/api/agents/a1/vision");
  assert.equal(EP.agents.visionBatch("a1"), "/api/agents/a1/vision/batch");
  assert.equal(EP.agents.guardrailsAnalytics("a1"), "/api/agents/a1/guardrails/analytics");
  assert.equal(EP.agents.guardrailsDryRun("a1"), "/api/agents/a1/guardrails/dry-run");
  assert.equal(EP.actions.bulkApprove, "/api/actions/bulk-approve");
  assert.equal(EP.actions.undo("x1"), "/api/actions/x1/undo");
  assert.equal(EP.webhooks.list, "/api/webhooks");
  assert.equal(EP.webhooks.create, "/api/webhooks");
  assert.equal(EP.webhooks.del("w1"), "/api/webhooks/w1");
  assert.equal(EP.webhooks.test("w1"), "/api/webhooks/w1/test");
  assert.equal(EP.webhooks.deliveries("w1"), "/api/webhooks/w1/deliveries");
  assert.equal(EP.webhooks.replay("w1", "d1"), "/api/webhooks/w1/deliveries/d1/replay");
  assert.equal(EP.status, "/api/status");
  assert.equal(EP.sms.send("o"), "/api/orgs/o/sms/send");
});

test("attributed usage is NOT org-prefixed (the key resolves the org)", () => {
  assert.equal(EP.usageBy, "/api/usage");
  assert.doesNotMatch(EP.usageBy, /orgs/);
});

// ── chat turn: the contract fields ───────────────────────────────────────────

test("turnBody carries every contract field under its wire name, and only when set", () => {
  const b = turnBody({
    message: "hi", sessionId: "s1", context: "ctx",
    responseSchema: { type: "object" }, cite: true, facts: { "listing.certId": "PSA-1" },
    costCenter: "sidestage:show_abc", modelTier: "fast", images: ["data:image/png;base64,AA=="],
  });
  assert.deepEqual(Object.keys(b).sort(), [
    "cite", "context", "cost_center", "facts", "images", "message", "model_tier", "response_schema", "session_id", "source",
  ]);
  assert.equal(b.response_schema.type, "object");
  assert.equal(b.cite, true);
  assert.equal(b.cost_center, "sidestage:show_abc");
  assert.equal(b.model_tier, "fast");
  // Nothing new leaks onto a plain turn — an older gateway sees exactly 1.4.0's body.
  assert.deepEqual(Object.keys(turnBody({ message: "hi", sessionId: "s1", facts: {}, images: [] })).sort(), ["message", "session_id", "source"]);
});

test("--facts k=v is typed leniently and merges over --facts-file", () => {
  const f = parseFacts(["listing.priceCents=12600", "listing.certId=PSA-12345", "verified=true", 'name="Bo"'], { "listing.certId": "OLD", extra: 1 });
  assert.deepEqual(f, { "listing.priceCents": 12600, "listing.certId": "PSA-12345", verified: true, name: "Bo", extra: 1 });
  assert.deepEqual(parseFacts(undefined, null), {});
});

test("turnOptions reads --schema/--context-file/--facts-file up front and puts the subject in a header", () => {
  const files = {
    "/s.json": '{"type":"object","required":["a"]}',
    "/ctx.txt": "viewers=1200",
    "/f.json": '{"listing.certId":"PSA-1"}',
    "/shot.png": Buffer.from("png"),
  };
  const read = (p, enc) => (enc ? String(files[p]) : files[p]);
  const { flags } = parse([
    "turn", "a1", "-m", "hi", "--stream", "--schema", "/s.json", "--cite", "--context-file", "/ctx.txt",
    "--facts-file", "/f.json", "--facts", "x=1", "--cost-center", "cc", "--model-tier", "complex",
    "--on-behalf-of", "user 42", "--image", "/shot.png",
  ]);
  const o = turnOptions(flags, read);
  assert.deepEqual(o.responseSchema, { type: "object", required: ["a"] });
  assert.equal(o.context, "viewers=1200");
  assert.equal(o.cite, true);
  assert.deepEqual(o.facts, { "listing.certId": "PSA-1", x: 1 });
  assert.equal(o.costCenter, "cc");
  assert.equal(o.modelTier, "complex");
  assert.equal(o.stream, true);
  assert.deepEqual(o.headers, { "X-Whissle-On-Behalf-Of": "user 42" });
  assert.match(o.images[0], /^data:image\/png;base64,/);
  // The subject is a HEADER, never a body field.
  assert.equal("subject" in turnBody({ message: "hi", ...o }), false);
});

test("an unknown --model-tier is refused before any request", () => {
  assert.throws(() => exits(() => turnOptions({ "model-tier": "huge" })), /exit 1/);
  assert.deepEqual(MODEL_TIERS, ["fast", "default", "complex"]);
});

test("a 413 for over-long context says the limit and what was sent", () => {
  const e = Object.assign(new Error("413 Payload Too Large"), { status: 413, body: { error: "context too long", max_chars: 32000, got: 40123 } });
  assert.match(explainTurnError(e), /40123/);
  assert.match(explainTurnError(e), /32000/);
  assert.equal(explainTurnError(Object.assign(new Error("500 boom"), { status: 500 })), "500 boom");
});

test("claims render text → chunk/doc/version/score, then the retrieved set", () => {
  const lines = claimLines(
    [{ text: "Refunds within 30 days.", chunk_id: "kbc_1", doc_id: "kbd_9", doc_version: 3, score: 0.81 }],
    [{ chunk_id: "kbc_1", doc_id: "kbd_9", doc_version: 3, score: 0.74 }, { chunk_id: "kbc_2", doc_id: "kbd_9", doc_version: 3, score: 0.5 }],
  ).map(PLAIN);
  assert.match(lines[0], /claims:/);
  assert.match(lines[1], /Refunds within 30 days/);
  assert.match(lines[2], /kbc_1 · kbd_9 v3 · score 0.81/);
  assert.match(lines[3], /retrieved: 2 chunk/);
  assert.deepEqual(claimLines([], []), []);
});

test("the turn footer names the tier that served and the trace id", () => {
  assert.deepEqual(contractFooterLines({ model_tier: "fast", trace_id: "trc_1" }).map(PLAIN), ["  tier fast · trace trc_1"]);
  assert.deepEqual(contractFooterLines({}), []);
});

// ── listen ───────────────────────────────────────────────────────────────────

test("listen start sends only what was asked for", () => {
  assert.deepEqual(startBody({}), {});
  assert.deepEqual(startBody({ language: "hi", metadata: true }), { language: "hi", metadata: true });
});

test("diffTail yields only the rows past what was already seen, and says when it ended", () => {
  const prev = { transcript: [{ role: "user", content: "hi", turn_id: "t1" }], signals: [] };
  const next = {
    transcript: [{ role: "user", content: "hi", turn_id: "t1" }, { role: "user", content: "I want a refund", turn_id: "t2" }],
    signals: [{ turn_id: "t2", emotion: "ANGRY", words_per_minute: 168, speech_ms: 2100, entity_disagreements: [{ label: "PSA-12345", kind: "cert" }] }],
    end_reason: "participant_left",
  };
  const d = diffTail(prev, next);
  assert.equal(d.transcript.length, 1);
  assert.equal(d.transcript[0].turn_id, "t2");
  assert.equal(d.signals.length, 1);
  assert.equal(d.ended, true);
  // The first poll sees everything.
  assert.equal(diffTail(null, next).transcript.length, 2);
  assert.equal(diffTail(null, { transcript: [], status: "active" }).ended, false);
  assert.equal(isEnded({ status: "completed" }), true);
});

test("signal and transcript lines carry the turn_id and the delivery numbers", () => {
  assert.equal(transcriptLine({ role: "user", content: "hello", turn_id: "t7" }), "[t7] user: hello");
  const l = signalLine({ turn_id: "t7", emotion: { label: "HAPPY" }, intent: "BUY", words_per_minute: 150.4, speech_ms: 900, entity_disagreements: [{ label: "Oslo", kind: "place" }] });
  assert.equal(l, "[t7] ⚡ emotion HAPPY · intent BUY · 150 wpm · 900ms speech · entity mismatch: Oslo (place)");
});

// ── vision ───────────────────────────────────────────────────────────────────

test("vision encodes a path as a data URL and passes a data URL through", () => {
  const read = () => Buffer.from("bytes");
  assert.equal(imageDataUrl("a.jpg", read), `data:image/jpeg;base64,${Buffer.from("bytes").toString("base64")}`);
  assert.match(imageDataUrl("a.GIF", read), /^data:image\/gif;base64,/);
  assert.equal(imageDataUrl("data:image/png;base64,AA==", read), "data:image/png;base64,AA==");
  assert.throws(() => exits(() => imageDataUrl("a.bmp", read)), /exit 1/);
});

test("ask + batch bodies match the door's shape, and a batch caps at 40", () => {
  assert.deepEqual(askBody({ image: "data:x", question: "what?", hint: "a card", maxWords: "20" }), { image: "data:x", question: "what?", hint: "a card", max_words: 20 });
  assert.deepEqual(Object.keys(askBody({ image: "i", question: "q" })), ["image", "question"]);
  const read = () => Buffer.from("b");
  const b = batchBody([{ id: 1, image: "x.png", question: "q1" }, { image: "data:image/png;base64,AA==", question: "q2", hint: "h" }], { concurrency: "3", read });
  assert.equal(b.concurrency, 3);
  assert.deepEqual(b.items.map((i) => i.id), ["1", "1"]);
  assert.match(b.items[0].image, /^data:image\/png;base64,/);
  assert.equal(b.items[1].hint, "h");
  assert.equal(BATCH_MAX, 40);
  const many = Array.from({ length: 41 }, (_, i) => ({ id: i, image: "data:image/png;base64,AA==", question: "q" }));
  assert.throws(() => exits(() => batchBody(many, { read })), /exit 1/);
});

// ── kb sync / eval ───────────────────────────────────────────────────────────

test("hashContent is sha256 hex of the bytes — the key the server dedupes on", () => {
  assert.equal(hashContent(Buffer.from("hello")), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

test("a document's title is its first heading, else its filename", () => {
  assert.equal(titleOf("faq/hours.md", "# Opening hours\n\nWe open at 9."), "Opening hours");
  assert.equal(titleOf("faq/hours.md", "no heading here"), "hours");
});

test("planSync PUTs every file with its hash and prunes only what is gone", () => {
  const files = [
    { externalId: "faq/hours.md", content: "# Hours\n9–5" },
    { externalId: "prices.csv", content: Buffer.from("a,b\n1,2") },
  ];
  const existing = [{ external_id: "faq/hours.md" }, { external_id: "old/page.md" }];
  const plan = planSync(files, existing, { namespace: "site", prune: true });
  assert.deepEqual(plan.puts[0], {
    externalId: "faq/hours.md",
    body: { title: "Hours", content: "# Hours\n9–5", mime: "text/markdown", namespace: "site", content_hash: hashContent(Buffer.from("# Hours\n9–5")) },
  });
  assert.equal(plan.puts[1].body.mime, "text/csv");
  assert.deepEqual(plan.deletes, ["old/page.md"]);
  // No --prune, no deletes — deleting what the caller never mentioned is not a default.
  assert.deepEqual(planSync(files, existing).deletes, []);
  assert.equal("namespace" in planSync(files, []).puts[0].body, false);
});

test("walkDir lists wanted extensions recursively with posix external ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "whissle-kb-"));
  try {
    mkdirSync(join(dir, "faq"));
    writeFileSync(join(dir, "faq", "hours.md"), "# Hours");
    writeFileSync(join(dir, "logo.png"), "x");
    writeFileSync(join(dir, ".hidden.md"), "x");
    writeFileSync(join(dir, "readme.txt"), "x");
    assert.deepEqual(walkDir(dir).map((f) => f.externalId), ["faq/hours.md", "readme.txt"]);
    assert.deepEqual(walkDir(dir, ["txt"]).map((f) => f.externalId), ["readme.txt"]);
    assert.deepEqual(SYNC_EXTS, ["md", "txt", "html", "json", "csv"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applySync accounts for unchanged / added / updated from the server's own answers", async () => {
  const calls = [];
  const replies = [{ unchanged: true }, { doc_id: "d2", doc_version: 1 }, { doc_id: "d3", doc_version: 4 }];
  const api = {
    put: async (path, body) => { calls.push(["PUT", path, body]); return replies.shift(); },
    del: async (path) => { calls.push(["DELETE", path]); return null; },
  };
  const plan = planSync(
    [{ externalId: "a.md", content: "a" }, { externalId: "b/c d.md", content: "b" }, { externalId: "e.md", content: "e" }],
    [{ external_id: "gone.md" }],
    { prune: true },
  );
  const stats = await applySync("a1", plan, api);
  assert.deepEqual(stats, { added: 1, updated: 1, unchanged: 1, removed: 1 });
  assert.equal(calls[0][1], "/api/agents/a1/kb/docs/a.md");
  assert.equal(calls[0][2].content_hash, hashContent(Buffer.from("a")));
  // The external id is a path segment: encoded, so a slash cannot become a route.
  assert.equal(calls[1][1], "/api/agents/a1/kb/docs/b%2Fc%20d.md");
  assert.deepEqual(calls[3], ["DELETE", "/api/agents/a1/kb/docs/gone.md"]);
});

test("evalBody takes {cases} or a bare array and types k", () => {
  assert.deepEqual(evalBody([{ question: "q", expected_doc_id: "d" }], "3"), { cases: [{ question: "q", expected_doc_id: "d" }], k: 3 });
  assert.deepEqual(evalBody({ cases: [{ question: "q" }] }), { cases: [{ question: "q" }] });
  assert.throws(() => exits(() => evalBody([{ nope: 1 }])), /exit 1/);
});

// ── usage --by ───────────────────────────────────────────────────────────────

test("usage --by validates the grouping and passes the window through", () => {
  assert.deepEqual(usageByQuery({ by: "cost_center", since: "2026-09-01", until: "2026-09-16" }), { by: "cost_center", since: "2026-09-01", until: "2026-09-16" });
  assert.deepEqual(USAGE_BY, ["agent", "cost_center", "subject", "session"]);
  assert.throws(() => exits(() => usageByQuery({ by: "day" })), /exit 1/);
});

// ── sessions trace: the text-turn contract fields ───────────────────────────

test("a traced text turn shows its tier, latency breakdown, retrieval, guardrail verdict and cost", () => {
  const lines = turnLines({
    turn: 0, latency_ms: { retrieve: 40, llm: 900, guard: 30, total: 1000 }, model_tier: "default",
    provider: "openai", model: "gpt-oss-120b", retrieved: ["kbc_1", "kbc_2"], cost_usd: 0.0031,
    guardrail: { verdict: "block", matched_rules: ["never_say:price"] },
  }).map(PLAIN);
  assert.match(lines[0], /1\.0s \(retrieve 40ms, llm 900ms, guard 30ms\)/);
  assert.match(lines[0], /tier default/);
  assert.match(lines[0], /2 chunks retrieved/);
  assert.match(lines[0], /\$0\.0031/);
  assert.match(lines[1], /GUARDRAIL BLOCK — never_say:price/);
  // An older trace with a bare number still renders as it always did.
  assert.deepEqual(latencyBits(3800), ["3.8s"]);
  assert.deepEqual(latencyBits(undefined), []);
  assert.match(turnLines({ latency_ms: 3800, hops: 2 })[0], /^⏱ turn  3\.8s · 2 hops$/);
});

// ── webhooks ─────────────────────────────────────────────────────────────────

test("webhookBody splits --events, keeps the secret optional and refuses unknown kinds", () => {
  const { flags } = parse(["create", "--url", "https://x.test/hook", "--events", "session.ended,tool.held", "--secret", "s3"]);
  assert.deepEqual(webhookBody(flags), { url: "https://x.test/hook", events: ["session.ended", "tool.held"], secret: "s3" });
  assert.deepEqual(webhookBody({ url: "https://x.test", events: ["kb.ingested", "balance.threshold"] }).events, ["kb.ingested", "balance.threshold"]);
  assert.throws(() => exits(() => webhookBody({ url: "https://x.test", events: "session.started" })), /exit 1/);
  assert.throws(() => exits(() => webhookBody({ url: "ftp://x", events: "tool.held" })), /exit 1/);
});

test("the six contract events and the signature scheme are spelled out", () => {
  assert.deepEqual(EVENT_KINDS.map(([k]) => k), ["session.ended", "tool.held", "approval.decided", "kb.ingested", "balance.threshold", "latency.threshold"]);
  assert.match(SIGNATURE_SCHEME, /X-Whissle-Signature: t=.*v1=hex\(hmac-sha256\(secret, t \+ "\." \+ body\)\)/);
});

test("webhooks --help is its own slice", () => {
  const help = PLAIN(helpFor("webhooks"));
  assert.match(help, /whissle webhooks create/);
  assert.match(help, /replay <id> <delivery-id>/);
  assert.doesNotMatch(help, /whissle alerts/);
});

// ── alerts kinds ─────────────────────────────────────────────────────────────

test("alerts create --kind builds a kind-rule with a default name and comparator", () => {
  const { flags } = parse(["create", "--kind", "balance_below_usd", "--threshold", "20", "--webhook", "w1"]);
  assert.deepEqual(kindRuleBody(flags), { kind: "balance_below_usd", threshold: 20, webhook_id: "w1", name: "Balance below $20", comparator: "below" });
  const p95 = kindRuleBody(parse(["create", "--kind", "p95_ms_over", "--door", "chat_turn", "--threshold", "1500", "--name", "slow"]).flags);
  assert.deepEqual(p95, { kind: "p95_ms_over", door: "chat_turn", threshold: 1500, name: "slow", comparator: "above" });
  assert.throws(() => exits(() => kindRuleBody({ kind: "p95_ms_over", threshold: "1" })), /exit 1/); // no --door
  assert.throws(() => exits(() => kindRuleBody({ kind: "cpu_hot", threshold: "1" })), /exit 1/);
  assert.deepEqual(ALERT_KINDS, ["balance_below_usd", "p95_ms_over"]);
  // The metric-rule body is untouched by the new flags.
  assert.deepEqual(ruleBody({ name: "n", metric: "completion_rate", threshold: "0.6" }), { name: "n", metric: "completion_rate", threshold: 0.6 });
});

// ── long tail ────────────────────────────────────────────────────────────────

test("bulk-approve resolves --ids or every pending id, and the idempotency key is a header", () => {
  assert.deepEqual(bulkIds({ ids: "a,b, c" }, []), ["a", "b", "c"]);
  assert.deepEqual(bulkIds({ ids: ["a", "b,c"] }, []), ["a", "b", "c"]);
  assert.deepEqual(bulkIds({ "all-pending": true }, [{ id: "p1", status: "pending" }, { id: "x", status: "approved" }, { id: "p2" }]), ["p1", "p2"]);
  assert.deepEqual(bulkIds({}, [{ id: "p1" }]), []);
  assert.deepEqual(decisionHeaders({ "idempotency-key": "k1" }), { "Idempotency-Key": "k1" });
  assert.deepEqual(decisionHeaders({}), { "Idempotency-Key": undefined });
});

test("sms send uses the gateway's field names", () => {
  assert.deepEqual(sendBody({ to: "+15551234567", body: "hi", from: "+15550000000", agent: "a1" }), { to_number: "+15551234567", body: "hi", from_number: "+15550000000", agent_id: "a1" });
  assert.deepEqual(Object.keys(sendBody({ to: "+1", body: "b" })), ["to_number", "body"]);
  assert.throws(() => exits(() => sendBody({ to: "+1" })), /exit 1/);
});

test("numbers provision buys the first search candidate, whichever shape the search answered in", () => {
  assert.equal(firstCandidate({ numbers: [{ phone_number: "+14155550100" }, { phone_number: "+14155550101" }] }), "+14155550100");
  assert.equal(firstCandidate([{ phoneNumber: "+14155550102" }]), "+14155550102");
  assert.equal(firstCandidate({ numbers: [] }), null);
});

test("the new verbs have help lines of their own", () => {
  for (const [group, needle] of [
    ["listen", /whissle listen tail/], ["vision", /whissle vision batch/], ["chat", /whissle chat turn/],
    ["kb", /whissle kb sync/], ["kb", /whissle kb eval/], ["usage", /whissle usage --by/], ["alerts", /alerts create --kind/],
    ["actions", /bulk-approve/], ["sms", /whissle sms send/], ["numbers", /numbers provision/],
  ]) {
    assert.match(PLAIN(helpFor(group)), needle, `${group} help lacks ${needle}`);
  }
});
