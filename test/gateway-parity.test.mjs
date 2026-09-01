// Unit tests for the 2026-09 gateway-parity round (node:test, no network):
// alerts, org usage, the studio voice catalog, reports, scenarios/simulations,
// the compliance attestations + erase/readiness, meetings summaries, and the
// transport-descriptor-derived embed hints. Pure helpers + EP paths only.
import test from "node:test";
import assert from "node:assert/strict";
import { EP } from "../src/endpoints.mjs";
import { parse } from "../bin/whissle.mjs";
import { ruleBody } from "../src/commands/alerts.mjs";
import { generateBody } from "../src/commands/reports.mjs";
import { filterVoices } from "../src/commands/voices.mjs";
import { SETTING_FLAGS, settingsBody } from "../src/commands/compliance.mjs";
import { meetRow } from "../src/commands/meetings.mjs";
import { connectHints } from "../src/commands/embed.mjs";

// ── endpoint paths (single source of truth → the real backend routes) ────────

test("alerts endpoints resolve to routes/alerts.py paths", () => {
  assert.equal(EP.alerts.options, "/api/alerts/options");
  assert.equal(EP.alerts.rules, "/api/alerts/rules");
  assert.equal(EP.alerts.rule("r1"), "/api/alerts/rules/r1");
  assert.equal(EP.alerts.ruleTest("r1"), "/api/alerts/rules/r1/test");
  assert.equal(EP.alerts.events, "/api/alerts/events");
});

test("org usage endpoints resolve to routes/usage.py paths", () => {
  assert.equal(EP.usage.summary("o"), "/api/orgs/o/usage/summary");
  assert.equal(EP.usage.events("o"), "/api/orgs/o/usage/events");
  assert.equal(EP.usage.sessions("o"), "/api/orgs/o/usage/sessions");
  assert.equal(EP.usage.export("o"), "/api/orgs/o/usage/export");
});

test("voices + reports endpoints resolve to the backend paths", () => {
  assert.equal(EP.voices, "/api/voices");
  assert.equal(EP.reports.list, "/api/reports");
  assert.equal(EP.reports.generate, "/api/reports/generate");
  assert.equal(EP.reports.corpus, "/api/reports/corpus");
});

test("scenario/simulation endpoints resolve to routes/simulations.py paths", () => {
  assert.equal(EP.agents.scenarios("a1"), "/api/agents/a1/scenarios");
  assert.equal(EP.agents.scenario("a1", "s1"), "/api/agents/a1/scenarios/s1");
  assert.equal(EP.agents.scenariosGenerate("a1"), "/api/agents/a1/scenarios/generate");
  assert.equal(EP.agents.simulations("a1"), "/api/agents/a1/simulations");
  assert.equal(EP.agents.simulationsRun("a1"), "/api/agents/a1/simulations/run");
});

test("compliance erase + readiness endpoints resolve to routes/compliance.py paths", () => {
  assert.equal(EP.compliance.erase("o"), "/api/orgs/o/compliance/erase");
  assert.equal(EP.compliance.readiness("o"), "/api/orgs/o/compliance/readiness");
});

// ── alerts: the rule body from flags ─────────────────────────────────────────

test("ruleBody types the numeric fields and maps --agent to agent_id", () => {
  const { flags } = parse([
    "rules", "add", "--name", "Low completion", "--metric", "completion_rate",
    "--comparator", "below", "--threshold", "0.6", "--agent", "a1",
    "--window-hours", "24", "--min-calls", "10", "--cooldown-hours", "48",
  ]);
  assert.deepEqual(ruleBody(flags), {
    name: "Low completion",
    metric: "completion_rate",
    comparator: "below",
    threshold: 0.6,        // float, not the string "0.6"
    agent_id: "a1",
    window_hours: 24,
    min_calls: 10,
    cooldown_hours: 48,
  });
});

test("ruleBody booleans accept bare flags and explicit true/false", () => {
  assert.deepEqual(ruleBody({ enabled: true, "notify-email": "false" }), {
    enabled: true,
    notify_email: false,
  });
  // Untouched flags stay out of the body entirely (a PUT is a sparse patch).
  assert.deepEqual(ruleBody({}), {});
});

// ── reports: the generate body from flags ────────────────────────────────────

test("generateBody collects repeated --question flags in order", () => {
  const { flags } = parse([
    "generate", "--agent", "a1", "--days", "14",
    "--question", "What do callers ask most?",
    "--question", "Where do we lose them?",
  ]);
  assert.deepEqual(generateBody(flags), {
    agent_id: "a1",
    days: 14,
    questions: ["What do callers ask most?", "Where do we lose them?"],
  });
});

test("generateBody with no flags sends an empty body (server defaults apply)", () => {
  assert.deepEqual(generateBody({}), {});
});

// ── voices: client-side catalog filter ───────────────────────────────────────

test("filterVoices narrows by language and gender, and passes everything unfiltered", () => {
  const catalog = [
    { language: "en", gender: "female", voice_id: "v1" },
    { language: "en", gender: "male", voice_id: "v2" },
    { language: "hi", gender: "female", voice_id: "v3" },
  ];
  assert.equal(filterVoices(catalog).length, 3);
  assert.deepEqual(filterVoices(catalog, { language: "en" }).map((v) => v.voice_id), ["v1", "v2"]);
  assert.deepEqual(filterVoices(catalog, { language: "en", gender: "male" }).map((v) => v.voice_id), ["v2"]);
  assert.deepEqual(filterVoices(catalog, { language: "zh" }), []);
});

// ── compliance: the attestation flags ────────────────────────────────────────

test("the two attestations are settable flags mapped to the backend fields", () => {
  assert.deepEqual(SETTING_FLAGS["contacts-are-customers"], ["contacts_are_customers", "bool"]);
  assert.deepEqual(SETTING_FLAGS["outreach-attested"], ["outreach_attested", "bool"]);
  const body = settingsBody({ "contacts-are-customers": "true", "outreach-attested": true });
  assert.deepEqual(body, { contacts_are_customers: true, outreach_attested: true });
  // Explicit false must SEND false (revoking an attestation), not omit the field.
  assert.deepEqual(settingsBody({ "outreach-attested": "false" }), { outreach_attested: false });
});

// ── meetings: the list row carries the summary ───────────────────────────────

test("meetRow shows the slim notes summary and dashes when absent", () => {
  const withNotes = meetRow({
    id: "m1", title: "Standup", status: "done", created_at: "2026-08-30T10:00:00Z",
    notes: { summary: "Shipped the thing; two follow-ups." }, meeting_url: "https://meet.google.com/x",
  });
  assert.equal(withNotes[4], "Shipped the thing; two follow-ups.");
  const without = meetRow({ id: "m2", title: "Planning", status: "scheduled" });
  assert.equal(without[4], "—");
});

// ── embed: connect hints derived from the transport descriptor ───────────────

const BASE = "https://aws-gateway-backend.whissle.ai/bot";

test("a livekit descriptor leads with livekit and keeps the webrtc fallback", () => {
  const transport = {
    kind: "livekit",
    url: "wss://sfu.example.com",
    connect: { method: "POST", url: "/api/embed/livekit", auth: "query:token" },
    fallbacks: [{
      kind: "webrtc",
      connect: { method: "POST", url: "/api/embed/offer", auth: "query:token" },
      trickle_ice: { method: "PATCH", url: "/api/embed/offer", auth: "query:token" },
    }],
    text: { connect: { method: "POST", url: "/api/embed/chat/turn", auth: "query:token" } },
  };
  const hints = connectHints(transport, BASE);
  assert.equal(hints.length, 3);
  assert.match(hints[0].label, /livekit/);
  assert.equal(hints[0].url, `${BASE}/api/embed/livekit?token=<token>`); // relative → absolute, token on the query
  assert.match(hints[1].label, /webrtc.*fallback/);
  assert.equal(hints[1].url, `${BASE}/api/embed/offer?token=<token>`);
  assert.equal(hints[2].label, "text");
  assert.equal(hints[2].url, `${BASE}/api/embed/chat/turn?token=<token>`);
});

test("a webrtc-only descriptor (no SFU configured) yields the offer door", () => {
  const transport = {
    kind: "webrtc",
    connect: { method: "POST", url: "/api/embed/offer", auth: "query:token" },
    trickle_ice: { method: "PATCH", url: "/api/embed/offer", auth: "query:token" },
    fallbacks: [],
  };
  const hints = connectHints(transport, BASE);
  assert.equal(hints.length, 1);
  assert.match(hints[0].label, /webrtc/);
  assert.doesNotMatch(hints[0].label, /fallback/);
  assert.match(hints[0].note, /trickle ICE/i);
});

test("an absolute descriptor URL is passed through untouched", () => {
  const transport = {
    kind: "webrtc",
    connect: { method: "POST", url: "https://edge.example.com/api/embed/offer", auth: "query:token" },
  };
  const [h] = connectHints(transport, BASE);
  assert.equal(h.url, "https://edge.example.com/api/embed/offer?token=<token>");
});

test("no descriptor (an older gateway) falls back to the known doors", () => {
  const hints = connectHints(undefined, BASE);
  assert.deepEqual(hints.map((h) => h.url), [
    `${BASE}/api/embed/offer?token=<token>`,
    `${BASE}/api/embed/chat/turn`,
  ]);
});

// ── arg parsing for the new commands ─────────────────────────────────────────

test("parse() reads agents simulate --scenario repeats as an array", () => {
  const { positionals, flags } = parse(["simulate", "a1", "--scenario", "s1", "--scenario", "s2"]);
  assert.deepEqual(positionals, ["simulate", "a1"]);
  assert.deepEqual(flags.scenario, ["s1", "s2"]);
});

test("parse() reads usage sessions --day and export --out", () => {
  const s = parse(["sessions", "--day", "2026-08-30", "--channel", "voice"]);
  assert.equal(s.flags.day, "2026-08-30");
  const e = parse(["export", "--days", "90", "--out", "usage.csv"]);
  assert.equal(e.flags.out, "usage.csv");
  assert.equal(e.flags.days, "90");
});
