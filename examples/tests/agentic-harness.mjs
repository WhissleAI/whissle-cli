#!/usr/bin/env node
// Long agentic-chat smoke test for CLI-created agents.
//
// For each scenario it CREATES the agent from its package (the exact `whissle
// agents create --file` path), drives a scripted MULTI-TURN conversation —
// threading conversation_id so context carries the way a real chat does — and
// captures every reply plus the tools each turn used. Then it flags what looks
// broken and DELETES the agent (it cleans up after itself).
//
// What it flags per turn:
//   • tool-trouble — the model narrated a tool failure ("I'm having a technical
//     issue retrieving …"). This is how the fhir_get_medications stash bug showed.
//   • tool-thrash  — the same tool hammered ≥3× in one turn (a retry loop).
//   • refusal      — the agent declined to help.
//   • missing tool — a turn's `expectTools` weren't called.
//
// Usage:
//   node examples/tests/agentic-harness.mjs examples/tests/scenarios/dental.json [more…]
//   node examples/tests/agentic-harness.mjs examples/tests/scenarios/*.json
//
// Auth/base come from the CLI's own config (~/.whissle/config.json or
// WHISSLE_API_KEY / WHISSLE_BASE_URL) — run `whissle login` first.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { post, del } from "../../src/api.mjs";
import { createFromSpec } from "../../src/commands/agents.mjs";

const TROUBLE =
  /technical (issue|difficulty|problem)|having (trouble|a technical)|isn'?t (retrieving|working|syncing)|can'?t (retrieve|access|pull up|find your|get your)|unable to (retrieve|access|find|pull)|not (retrieving|able to retrieve)|try again (later|in a)|system (is|isn'?t) (syncing|down|unavailable)|rather than keep you waiting/i;
const REFUSAL =
  /I (can'?t|cannot|am not able to|won'?t be able to) (help|assist|do that)|I'?m (not able|unable) to (help|assist)/i;

function toolNames(tools) {
  return (tools || []).map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
}

function flagsForTurn(reply, tools, expect) {
  // HARD = a real defect: a failure the model narrated, a retry loop, a refusal.
  // SOFT = informational: an expected tool wasn't called THIS turn — which is
  // often correct (the agent gathers prerequisites first, or RAG is ambient and
  // never surfaces as a tool call). Soft flags print but don't count as findings.
  const hard = [];
  const soft = [];
  if (TROUBLE.test(reply)) hard.push("tool-trouble (model narrated a failure)");
  if (REFUSAL.test(reply)) hard.push("refusal");
  const counts = {};
  for (const n of toolNames(tools)) counts[n] = (counts[n] || 0) + 1;
  for (const [n, c] of Object.entries(counts)) if (c >= 3) hard.push(`tool-thrash: ${n} ×${c}`);
  if (expect?.length) {
    const used = new Set(Object.keys(counts));
    const missing = expect.filter((e) => !used.has(e));
    if (missing.length) soft.push(`expected tool not seen this turn (may be deferred/ambient): ${missing.join(", ")}`);
  }
  return { hard, soft };
}

async function runScenario(path) {
  const scn = JSON.parse(readFileSync(path, "utf8"));
  const pkgPath = resolve(dirname(path), scn.package);
  const spec = JSON.parse(readFileSync(pkgPath, "utf8"));
  console.log(`\n══ ${scn.name || spec.name} ══  (${scn.turns.length} turns)`);
  if (scn.note) console.log(`   note: ${scn.note}`);

  const agent = await createFromSpec(spec, dirname(pkgPath), { json: true });
  const id = agent.id;
  let convId = null;
  const findings = [];
  try {
    for (let i = 0; i < scn.turns.length; i++) {
      const turn = scn.turns[i];
      let r;
      try {
        r = await post(`/api/agents/${id}/chat/turn`, {
          message: turn.say,
          ...(convId ? { conversation_id: convId } : {}),
        });
      } catch (e) {
        console.log(`  ✗ [${i + 1}] you: ${turn.say}`);
        console.log(`       API error: ${e.message}`);
        findings.push({ turn: i + 1, say: turn.say, flags: [`API error: ${e.message}`] });
        continue;
      }
      convId = r.conversation_id || convId;
      const names = toolNames(r.tools_used);
      const { hard, soft } = flagsForTurn(r.reply || "", r.tools_used, turn.expectTools);
      const reply = (r.reply || "").replace(/\s+/g, " ");
      console.log(`  ${hard.length ? "⚠" : "✓"} [${i + 1}] you: ${turn.say}`);
      console.log(`       bot: ${reply.slice(0, 150)}${reply.length > 150 ? "…" : ""}`);
      if (names.length) console.log(`       ⚙ ${names.join(", ")}`);
      for (const f of hard) console.log(`       ⚠ ${f}`);
      for (const f of soft) console.log(`       ℹ ${f}`);
      if (hard.length) findings.push({ turn: i + 1, say: turn.say, flags: hard });
    }
  } finally {
    await del(`/api/agents/${id}`, { query: { confirm: "true" } }).catch(() => {});
  }
  return { agent: spec.name, turns: scn.turns.length, findings };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node examples/tests/agentic-harness.mjs <scenario.json> [more…]");
  process.exit(1);
}

const results = [];
for (const f of files) {
  try {
    results.push(await runScenario(f));
  } catch (e) {
    console.error(`✗ ${f}: ${e.message}`);
  }
}

console.log("\n═══ SUMMARY ═══");
let total = 0;
for (const r of results) {
  total += r.findings.length;
  console.log(`  ${r.findings.length ? "⚠" : "✓"} ${r.agent}: ${r.turns} turns, ${r.findings.length} flagged`);
}
console.log(`\n${total ? "⚠" : "✓"} ${total} finding(s) across ${results.length} agent(s).`);
process.exit(total ? 1 : 0);
