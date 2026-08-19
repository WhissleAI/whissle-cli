// A flow that names a tool the agent does not have fails SILENTLY at runtime: the
// state machine routes into a state whose tool can never fire, so the agent
// improvises instead of calling it. That is not hypothetical — the ApplianceCare
// agent shipped with a leftover generic flow referencing `lookup_record`,
// `collect_digits`, `send_sms`, `send_email` and `schedule_callback` while the agent
// itself had only `search_knowledge_base` and `take_message`, and every benchmark
// task failed with no error surfaced anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFlowTools, flowToolRefs } from "../src/commands/agents.mjs";

const flowWith = (states, transitions = []) => ({ states, transitions });

test("a sound flow reports no missing tools", () => {
  const flow = flowWith([
    { id: "a", allowed_tools: ["get_customer_by_phone"] },
    { id: "b", allowed_tools: ["list_owned_appliances", "get_appliance_details"] },
  ]);
  const r = validateFlowTools(flow, [
    "get_customer_by_phone", "list_owned_appliances", "get_appliance_details",
  ]);
  assert.deepEqual(r.missing, []);
});

test("a tool the agent lacks is reported with the states that use it", () => {
  const flow = flowWith([
    { id: "resolve", allowed_tools: ["lookup_record"] },
    { id: "notify", allowed_tools: ["send_sms", "lookup_record"] },
  ]);
  const r = validateFlowTools(flow, ["search_knowledge_base", "take_message"]);
  assert.equal(r.missing.length, 2);
  const byTool = Object.fromEntries(r.missing.map((m) => [m.tool, m.states]));
  assert.deepEqual(byTool.lookup_record, ["resolve", "notify"]);
  assert.deepEqual(byTool.send_sms, ["notify"]);
});

test("a tool-type state's direct `tool` field is checked too", () => {
  // The generic flow's verify_identity/transfer_human states carry `tool`, not
  // `allowed_tools` — checking only allowed_tools would miss them entirely.
  const flow = flowWith([{ id: "verify", type: "tool", tool: "collect_digits" }]);
  const r = validateFlowTools(flow, ["take_message"]);
  assert.deepEqual(r.missing, [{ tool: "collect_digits", states: ["verify"] }]);
});

test("a transition's requires_tool is checked", () => {
  const flow = flowWith(
    [{ id: "verify", allowed_tools: [] }],
    [{ id: "t1", from: "verify", to: "done", requires_tool: "collect_digits" }],
  );
  const r = validateFlowTools(flow, []);
  assert.deepEqual(r.missing, [{ tool: "collect_digits", states: ["transition:t1"] }]);
});

test("tool objects are accepted, not just bare names", () => {
  const flow = flowWith([{ id: "a", allowed_tools: ["search_manuals"] }]);
  assert.deepEqual(validateFlowTools(flow, [{ name: "search_manuals" }]).missing, []);
});

test("an empty or toolless flow is valid", () => {
  assert.deepEqual(validateFlowTools({ states: [] }, []).missing, []);
  assert.deepEqual(validateFlowTools({}, []).missing, []);
  assert.deepEqual(validateFlowTools({ states: [{ id: "greet" }] }, []).missing, []);
});

test("flowToolRefs deduplicates a tool used by several states", () => {
  const refs = flowToolRefs(flowWith([
    { id: "a", allowed_tools: ["x"] },
    { id: "b", allowed_tools: ["x"] },
  ]));
  assert.deepEqual([...refs.keys()], ["x"]);
  assert.deepEqual(refs.get("x"), ["a", "b"]);
});

// ── the real artifacts ───────────────────────────────────────────────────────

test("the shipped ApplianceCare flow matches the ApplianceCare tools exactly", () => {
  const flow = JSON.parse(
    readFileSync(new URL("../examples/agents/appliance-care/flow.json", import.meta.url), "utf8"),
  );
  // The tools tau2's appliance_care domain exposes to the agent (@is_tool).
  const tau2Tools = [
    "search_manuals", "open_manual_section", "lookup_error_code",
    "get_customer_by_phone", "get_customer_by_name", "list_owned_appliances",
    "get_appliance_details", "identify_model", "get_model_details",
    "check_warranty", "get_service_history", "create_support_case",
    "escalate_safety_issue", "schedule_service", "record_resolution",
    "transfer_to_human_agents",
  ];
  const r = validateFlowTools(flow, tau2Tools);
  assert.deepEqual(r.missing, [], "flow references a tool the domain does not provide");
  // Also assert no tool is left unreachable — an unused tool means a task that
  // needs it can never be satisfied by the flow.
  const unused = tau2Tools.filter((t) => !r.referenced.includes(t));
  assert.deepEqual(unused, [], "domain tools unreachable from the flow");
});

test("the ApplianceCare flow resolves an appliance before any appliance_id tool", () => {
  const flow = JSON.parse(
    readFileSync(new URL("../examples/agents/appliance-care/flow.json", import.meta.url), "utf8"),
  );
  const byId = Object.fromEntries(flow.states.map((s) => [s.id, s]));
  // These tools take an internal appliance_id. The state that produces one is
  // resolve_appliance (via list_owned_appliances); every consumer must be
  // reachable only after it.
  const resolve = byId.resolve_appliance;
  assert.ok(resolve, "flow must have a resolve_appliance state");
  assert.ok(
    resolve.allowed_tools.includes("list_owned_appliances"),
    "resolve_appliance must be able to list the customer's appliances",
  );
  assert.match(
    resolve.goal,
    /never pass a model number.*serial number.*appliance_id/is,
    "resolve_appliance must warn against passing a model/serial as appliance_id",
  );
  // No state may reach an appliance_id consumer without passing through resolve.
  const consumers = ["create_support_case", "escalate_safety_issue", "record_resolution"];
  const reachableFromStart = new Set(["greet"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const tr of flow.transitions) {
      if (reachableFromStart.has(tr.from) && tr.from !== "resolve_appliance"
          && !reachableFromStart.has(tr.to)) {
        reachableFromStart.add(tr.to);
        changed = true;
      }
    }
  }
  for (const st of flow.states) {
    if (!reachableFromStart.has(st.id)) continue;
    for (const c of consumers) {
      assert.ok(
        !(st.allowed_tools || []).includes(c),
        `${st.id} can call ${c} without passing through resolve_appliance`,
      );
    }
  }
});
