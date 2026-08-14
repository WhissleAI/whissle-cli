// whissle agents list|get|create|update|delete
//
// `create --file agent.json` treats the file as a full agent PACKAGE: it creates
// the agent, applies audio/config settings, and ingests any `knowledge` in one go.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { get, post, patch, del, upload } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, err, ok, table, kv, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";
import { exitCodeFor } from "../exit.mjs";

// Fields that go in the create body vs. a follow-up PATCH (audio/config are
// PATCH-only). Anything else in the file is passed through to create as-is.
const CREATE_FIELDS = [
  "name", "system_prompt", "greeting", "agent_type", "direction",
  "voice", "voice_gender", "language_mode", "variables", "tools", "video_enabled",
];
const PATCH_FIELDS = [
  "audio_ambience", "audio_humanizer_intensity", "ambient_scene", "ambient_level_db",
  "audio_inline_sounds", "tool_sounds", "disposition_tool_map", "action_policy",
  "further_action_map", "scoring_prompt",
  // The in-call conversation flow (state machine). AgentUpdate accepts it, so a
  // `flow` key in an agent file must survive create/update — see `agents flow`.
  "flow",
];

function bodyFromFlags(flags) {
  const b = {};
  if (flags.name) b.name = flags.name;
  if (flags.prompt) b.system_prompt = flags.prompt;
  if (flags.greeting) b.greeting = flags.greeting;
  if (flags.type) b.agent_type = flags.type;
  if (flags.voice) b.voice = flags.voice;
  if (flags["voice-gender"]) b.voice_gender = flags["voice-gender"];
  if (flags.language) b.language_mode = flags.language;
  if (flags.direction) b.direction = flags.direction;
  return b;
}

// Tools may be listed as bare names ["get_hours"] or objects [{name,enabled}].
const normalizeTools = (tools) =>
  (tools || []).map((t) => (typeof t === "string" ? { name: t, enabled: true } : { enabled: true, ...t }));

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// The fields a file-based create/update carries into the PATCH body. Exported so
// a unit test can assert a `flow` key survives patch-building (regression guard).
export const FILE_PATCH_FIELDS = [...CREATE_FIELDS, ...PATCH_FIELDS];

// `flow set --file` accepts either a bare flow object (`{version, states, …}`) or
// a wrapper `{flow: {...}}`; normalize to the bare flow the backend expects.
export function unwrapFlow(parsed) {
  if (parsed && typeof parsed === "object" && parsed.flow && !parsed.states) return parsed.flow;
  return parsed;
}

async function ingestKnowledge(agentId, knowledge, baseDir, quiet) {
  let n = 0;
  for (const item of knowledge || []) {
    try {
      if (item.url) {
        await post(EP.agents.kb.fromUrl(agentId), { url: item.url });
      } else if (item.file) {
        await upload(EP.agents.kb.upload(agentId), {
          filePath: resolve(baseDir, item.file),
          fields: { title: item.title },
        });
      } else if (item.text) {
        await post(EP.agents.kb.base(agentId), {
          title: item.title || "Snippet", content: item.text, source_type: "snippet",
        });
      } else {
        continue;
      }
      n++;
      if (!quiet) out(dim(`    + knowledge: ${item.title || item.url || item.file}`));
    } catch (e) {
      // Surface failures on stderr even in --json mode; never pollute stdout JSON.
      err(dim(`    ! knowledge failed (${item.title || item.url || item.file}): ${e.message}`));
    }
  }
  return n;
}

export async function createFromSpec(spec, baseDir, flags) {
  const quiet = !!flags.json; // keep stdout clean for --json (only the final object)
  // Accept prompt_seed (whissle_agent_data manifests) as system_prompt.
  if (!spec.system_prompt && spec.prompt_seed) spec.system_prompt = spec.prompt_seed;
  if (!spec.name || !spec.system_prompt) {
    fatal("The agent file needs at least `name` and `system_prompt` (or `prompt_seed`).");
  }
  const createBody = pick(spec, CREATE_FIELDS);
  if (createBody.tools) createBody.tools = normalizeTools(createBody.tools);

  const agent = await post(EP.agents.create, createBody);
  if (!quiet) ok(`Created agent ${agent.id} — ${agent.name}`);

  const patchBody = pick(spec, PATCH_FIELDS);
  if (Object.keys(patchBody).length) {
    await patch(EP.agents.update(agent.id), patchBody);
    if (!quiet) out(dim("    · applied audio/config settings"));
  }

  const kn = spec.knowledge || spec.knowledge_files;
  if (kn?.length) {
    const count = await ingestKnowledge(agent.id, kn, baseDir, quiet);
    if (!quiet) out(dim(`    · ingested ${count} knowledge document(s)`));
  }
  return agent;
}

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const agents = await get(EP.agents.list);
    if (flags.json) return printJson(agents);
    table(
      ["ID", "NAME", "TYPE", "DIR"],
      (agents || []).map((a) => [a.id, trunc(a.name, 32), a.agent_type || "general", a.direction || "—"]),
    );
    out(dim(`\n  ${(agents || []).length} agent(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle agents get <agent-id>");
    const a = await get(EP.agents.get(id));
    if (flags.json) return printJson(a);
    kv(a, ["id", "name", "agent_type", "direction", "greeting", "voice", "voice_gender", "language_mode", "ambient_scene", "audio_inline_sounds", "video_enabled"]);
    out("\n  " + dim("system_prompt:"));
    out("  " + String(a.system_prompt || "").replace(/\n/g, "\n  "));
    out("\n  " + dim("tools: ") + (a.tools || []).map((t) => t.name).join(", "));
    return;
  }

  if (sub === "create") {
    if (flags.file) {
      const spec = JSON.parse(readFileSync(flags.file, "utf8"));
      const a = await createFromSpec(spec, dirname(resolve(flags.file)), flags);
      if (flags.json) return printJson(a);
      out(dim("  Test it: ") + `whissle chat ${a.id}`);
      return;
    }
    const body = bodyFromFlags(flags);
    if (!body.name || !body.system_prompt) {
      fatal("create needs --name and --prompt (or --file agent.json with name + system_prompt).");
    }
    const a = await post(EP.agents.create, body);
    if (flags.json) return printJson(a);
    ok(`Created agent ${a.id} — ${a.name}`);
    out(dim("  Test it: ") + `whissle chat ${a.id}`);
    return;
  }

  if (sub === "update") {
    const id = args[0] || fatal("Usage: whissle agents update <agent-id> [--prompt … | --file …]");
    const body = flags.file
      ? pick(JSON.parse(readFileSync(flags.file, "utf8")), FILE_PATCH_FIELDS)
      : bodyFromFlags(flags);
    if (body.tools) body.tools = normalizeTools(body.tools);
    const a = await patch(EP.agents.update(id), body);
    if (flags.json) return printJson(a);
    ok(`Updated agent ${id}`);
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle agents delete <agent-id> [--force]");
    let r;
    try {
      r = await del(EP.agents.del(id), { query: { confirm: flags.force ? "true" : undefined } });
    } catch (e) {
      // Rephrasing a caught failure must not cost its status — see ui.fatal.
      if (e.status === 409 && !flags.force) {
        fatal(`${e.message}\n  Re-run with --force to delete the agent and its knowledge.`, exitCodeFor(e));
      }
      throw e;
    }
    if (flags.json) return printMutation(r, { deleted: id });
    ok(`Deleted agent ${id}`);
    return;
  }

  if (sub === "versions") {
    // Saved-config history, newest first — every meaningful save is snapshotted,
    // so an overwrite is recoverable via `agents rollback`.
    const id = args[0] || fatal("Usage: whissle agents versions <agent-id>");
    const rows = await get(EP.agents.versions(id));
    if (flags.json) return printJson(rows);
    table(
      ["VERSION", "ID", "REASON", "NAME", "PROMPT", "WHEN"],
      (rows || []).map((v) => [
        `v${v.version_no}`, v.id, trunc(v.reason || "—", 20), trunc(v.name || "—", 24),
        `${v.prompt_chars ?? 0} ch`, (v.created_at || "").slice(0, 16).replace("T", " "),
      ]),
    );
    out(dim(`\n  ${(rows || []).length} version(s)  ·  restore one: whissle agents rollback ${id} <version-id>`));
    return;
  }

  if (sub === "rollback") {
    const id = args[0];
    const vid = args[1];
    if (!id || !vid) fatal("Usage: whissle agents rollback <agent-id> <version-id>   (version ids: whissle agents versions <agent-id>)");
    const a = await post(EP.agents.rollback(id, vid));
    if (flags.json) return printJson(a);
    ok(`Rolled back agent ${id} — now "${a.name}"`);
    out(dim("  Content only: deployment/routing (number, embed) is untouched, and the restore itself is snapshotted."));
    return;
  }

  if (sub === "clone") {
    const id = args[0] || fatal("Usage: whissle agents clone <agent-id>");
    const a = await post(EP.agents.clone(id));
    if (flags.json) return printJson(a);
    ok(`Cloned agent ${id} → ${a.id} — ${a.name}`);
    out(dim("  The copy starts undeployed (no number, embed off). Test it: ") + `whissle chat ${a.id}`);
    return;
  }

  if (sub === "types") {
    // Discovery: the agent-type keys you can pass to `--type` / an agent file.
    const types = await get(EP.agentTypes);
    if (flags.json) return printJson(types);
    table(
      ["KEY", "LABEL", "MODALITY", "APPTS"],
      (types || []).map((t) => [
        t.key, trunc(t.label || t.name || "—", 32), t.modality || "—",
        t.does_appointments ? "yes" : "—",
      ]),
    );
    out(dim(`\n  ${(types || []).length} type(s)`));
    return;
  }

  if (sub === "flow") return runFlow(args[0], args.slice(1), flags);

  fatal(`Unknown: agents ${sub}. Try list | get | create | update | delete | versions | rollback | clone | flow | types.`);
}

// ── agents flow show|set|generate|trace|publish|discard ──────────────────────
// The in-call conversation flow (a per-agent state machine) that drives
// flow-based, guard-railed voice/text agents. Authoring is a PATCH of `{flow}`
// (default live; `--draft` stages it for `flow publish`).

const FLOW_USAGE =
  "Usage: whissle agents flow <show|set|generate|trace|publish|discard> <agent-id> [opts]";

function printFlow(flow) {
  if (!flow || !Object.keys(flow).length) {
    out(dim("  (no flow)"));
    return;
  }
  const s = flow.settings || {};
  kv(
    {
      version: flow.version,
      enabled: flow.enabled,
      start_state: flow.start_state,
      states: (flow.states || []).length,
      variables: (flow.variables || []).length,
      on_guard_trip: s.on_guard_trip,
      fallback_state: s.fallback_state,
      max_transitions_per_call: s.max_transitions_per_call,
      max_visits_per_state: s.max_visits_per_state,
    },
    ["version", "enabled", "start_state", "states", "variables",
     "on_guard_trip", "fallback_state", "max_transitions_per_call", "max_visits_per_state"],
  );
  const states = flow.states || [];
  if (states.length) {
    out("\n  " + dim("states:"));
    table(
      ["ID", "TYPE", "LABEL / SAY", "TOOLS"],
      states.map((st) => [
        st.id, st.type || "—", trunc(st.label || st.say || "—", 44),
        (st.allowed_tools || []).join(", ") || "—",
      ]),
    );
  }
  if (Array.isArray(flow.transitions)) out(dim(`\n  ${flow.transitions.length} transition(s)`));
}

async function runFlow(verb, args, flags) {
  if (!verb) fatal(FLOW_USAGE);

  if (verb === "show") {
    const id = args[0] || fatal("Usage: whissle agents flow show <agent-id> [--json]");
    const a = await get(EP.agents.get(id));
    if (flags.json) return printJson(a.flow ?? null);
    if (!a.flow || !Object.keys(a.flow).length) {
      out(dim(`  Agent ${id} has no conversation flow.`));
      out(dim(`  Draft one: whissle agents flow generate ${id} --goal "…"`));
      return;
    }
    printFlow(a.flow);
    // Best-effort derived views — a failure here never breaks `flow show`.
    try {
      const wf = await get(EP.agents.workflow(id));
      if (wf?.summary) out("\n  " + dim("workflow: ") + JSON.stringify(wf.summary));
    } catch { /* derived view unavailable */ }
    try {
      const gr = await get(EP.agents.guardrails(id));
      const n = (gr?.groups || []).reduce((sum, g) => sum + (g.items || []).length, 0);
      if (n) out(dim(`  guardrails: ${n} rule(s) across ${(gr.groups || []).length} group(s)`));
    } catch { /* derived view unavailable */ }
    return;
  }

  if (verb === "set") {
    const id = args[0] || fatal("Usage: whissle agents flow set <agent-id> --file flow.json [--draft]");
    if (!flags.file) fatal("--file flow.json is required.");
    const parsed = JSON.parse(readFileSync(flags.file, "utf8"));
    const flow = unwrapFlow(parsed);
    const target = flags.draft ? "draft" : "live";
    const a = await patch(EP.agents.update(id), { flow }, { query: { target } });
    if (flags.json) return printJson(a);
    ok(`Saved flow to agent ${id} (${target})`);
    if (target === "draft") out(dim(`  Stage only — go live: whissle agents flow publish ${id}`));
    return;
  }

  if (verb === "generate") {
    const id = args[0] || fatal('Usage: whissle agents flow generate <agent-id> --goal "…"');
    // Backend field is `instructions`; --goal is the friendly alias. Both optional.
    const instructions = flags.goal || flags.instructions;
    const res = await post(EP.agents.flowGenerate(id), instructions ? { instructions } : {});
    if (flags.json) return printJson(res);
    ok(`Drafted a starter flow for agent ${id}`);
    printFlow(res.flow);
    if ((res.warnings || []).length) {
      out("\n  " + dim("warnings:"));
      for (const w of res.warnings) out("    " + dim("· " + w));
    }
    out(dim(`\n  Not saved. Review, then: whissle agents flow set ${id} --file flow.json [--draft]`));
    return;
  }

  if (verb === "trace") {
    const id = args[0] || fatal("Usage: whissle agents flow trace <agent-id> --conversation <id>");
    // The backend REQUIRES conversation_id (Query(..., min_length=1)).
    const conv = flags.conversation || fatal("--conversation <id> is required (a conversation that ran this flow).");
    const res = await get(EP.agents.flowTrace(id), { query: { conversation_id: conv } });
    if (flags.json) return printJson(res);
    kv(res, ["conversation_id", "current_state", "flow_version"]);
    const steps = res.steps || [];
    out("\n  " + dim("steps:"));
    table(
      ["#", "STATE", "EVENT", "DETAIL"],
      steps.map((st, i) => [
        String(i + 1), st.state || st.current_state || "—",
        st.event || st.kind || st.type || "—",
        trunc(st.detail || st.message || st.transition || st.note || "", 44),
      ]),
    );
    out(dim(`\n  ${steps.length} step(s)`));
    return;
  }

  if (verb === "publish") {
    const id = args[0] || fatal("Usage: whissle agents flow publish <agent-id>");
    const a = await post(EP.agents.publish(id));
    if (flags.json) return printJson(a);
    ok(`Published draft → live for agent ${id}`);
    return;
  }

  if (verb === "discard") {
    const id = args[0] || fatal("Usage: whissle agents flow discard <agent-id>");
    const a = await post(EP.agents.discardDraft(id));
    if (flags.json) return printJson(a);
    ok(`Discarded pending draft for agent ${id}`);
    return;
  }

  fatal(`Unknown: agents flow ${verb}. Try show | set | generate | trace | publish | discard.`);
}
