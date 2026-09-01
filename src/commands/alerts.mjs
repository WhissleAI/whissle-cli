// whissle alerts — self-service metric thresholds + the fired-event trail.
//
// Rules live on /api/alerts/rules (CRUD; the evaluation runs server-side on a
// loop). `rules test <id>` measures a rule RIGHT NOW — observed value, calls in
// window, would it fire — with no event row, no email and no cooldown consumed,
// so a rule can be sanity-checked before anyone waits a tick for it. `options`
// is the vocabulary (valid metrics + comparators, the same whitelist the
// evaluator uses); `events` is what actually fired.
// The key resolves the org; rule writes need an owner/admin key.
import { readFileSync } from "node:fs";
import { get, post, put, del } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

// --flag → rule field. Mirrors RuleBody/RulePatch in the backend (routes/alerts.py).
// Booleans accept an explicit true/false value or a bare flag (= true).
const RULE_FLAGS = {
  name: ["name", "str"],
  metric: ["metric", "str"],
  comparator: ["comparator", "str"],
  threshold: ["threshold", "float"],
  agent: ["agent_id", "str"],
  "window-hours": ["window_hours", "int"],
  "min-calls": ["min_calls", "int"],
  "cooldown-hours": ["cooldown_hours", "int"],
  enabled: ["enabled", "bool"],
  "notify-email": ["notify_email", "bool"],
};

/** The rule body from flags (or --file). Pure — exported for tests. */
export function ruleBody(flags) {
  if (flags.file) return JSON.parse(readFileSync(flags.file, "utf8"));
  const body = {};
  for (const [flag, [field, type]] of Object.entries(RULE_FLAGS)) {
    const v = flags[flag];
    if (v === undefined) continue;
    if (type === "int") body[field] = parseInt(v, 10);
    else if (type === "float") body[field] = parseFloat(v);
    else if (type === "bool") body[field] = v === true || String(v).toLowerCase() === "true";
    else body[field] = String(v);
  }
  return body;
}

const ruleRow = (r) => [
  r.id,
  trunc(r.name || "—", 24),
  `${r.metric} ${r.comparator} ${r.threshold}`,
  `${r.window_hours}h`,
  r.agent_id ? trunc(r.agent_id, 12) : "all",
  r.enabled ? "on" : "off",
  r.last_fired_at ? when(r.last_fired_at) : "—",
];

const RULES_USAGE =
  "Usage: whissle alerts rules [add|update <id>|delete <id>|test <id>] [--flags]\n" +
  "  add/update flags: --name N --metric M --threshold X [--comparator above|below]\n" +
  "                    [--agent <id>] [--window-hours 24] [--min-calls 0]\n" +
  "                    [--cooldown-hours 24] [--enabled true|false] [--notify-email true|false]\n" +
  "  metric keys: whissle alerts options";

async function runRules(verb, args, flags) {
  if (!verb || verb === "list") {
    const res = await get(EP.alerts.rules);
    if (flags.json) return printJson(res);
    const rules = res?.rules || [];
    table(["ID", "NAME", "FIRES WHEN", "WINDOW", "AGENT", "ENABLED", "LAST FIRED"], rules.map(ruleRow));
    out(dim(`\n  ${rules.length} rule(s)  ·  whissle alerts rules add --name … --metric … --threshold …`));
    return;
  }

  if (verb === "add") {
    const body = ruleBody(flags);
    if (!body.name || !body.metric || body.threshold === undefined) {
      fatal("rules add needs at least --name, --metric and --threshold.\n" + RULES_USAGE);
    }
    const r = await post(EP.alerts.rules, body);
    if (flags.json) return printJson(r);
    ok(`Created alert rule ${r.id} — ${r.name} (${r.metric} ${r.comparator} ${r.threshold})`);
    out(dim(`  Sanity-check it now: whissle alerts rules test ${r.id}`));
    return;
  }

  if (verb === "update") {
    const id = args[0] || fatal("Usage: whissle alerts rules update <rule-id> [--flags]\n" + RULES_USAGE);
    const body = ruleBody(flags);
    if (!Object.keys(body).length) fatal("Nothing to update — pass at least one rule flag.\n" + RULES_USAGE);
    const r = await put(EP.alerts.rule(id), body);
    if (flags.json) return printJson(r);
    ok(`Updated alert rule ${id}`);
    kv(r, ["name", "metric", "comparator", "threshold", "window_hours", "min_calls", "cooldown_hours", "enabled", "notify_email"]);
    return;
  }

  if (verb === "delete") {
    const id = args[0] || fatal("Usage: whissle alerts rules delete <rule-id>");
    const r = await del(EP.alerts.rule(id));
    if (flags.json) return printMutation(r, { deleted: id });
    ok(`Deleted alert rule ${id}`);
    return;
  }

  if (verb === "test") {
    // Measure the rule right now — no event row, no email, no cooldown consumed.
    const id = args[0] || fatal("Usage: whissle alerts rules test <rule-id>");
    const r = await post(EP.alerts.ruleTest(id), {});
    if (flags.json) return printJson(r);
    kv(
      {
        observed: r.observed,
        calls_in_window: r.calls_in_window,
        would_fire: r.would_fire ? "YES" : "no",
      },
      ["observed", "calls_in_window", "would_fire"],
    );
    if (r.message) out("\n  " + dim(r.message));
    return;
  }

  fatal(`Unknown: alerts rules ${verb}. Try list | add | update | delete | test.`);
}

export async function run(sub, args, flags) {
  if (!sub || sub === "rules") return runRules(args[0], args.slice(1), flags);

  if (sub === "options") {
    // The vocabulary the rule editor accepts — metrics + comparators, from the
    // same whitelist the evaluator uses, so the CLI can never write a rule the
    // backend can't evaluate.
    const res = await get(EP.alerts.options);
    if (flags.json) return printJson(res);
    table(["METRIC", "LABEL"], (res?.metrics || []).map((m) => [m.key, m.label || "—"]));
    out(dim(`\n  comparators: ${(res?.comparators || []).join(" | ")}`));
    return;
  }

  if (sub === "events") {
    const res = await get(EP.alerts.events, { query: { days: flags.days, limit: flags.limit } });
    if (flags.json) return printJson(res);
    const events = res?.events || [];
    table(
      ["WHEN", "RULE", "OBSERVED", "THRESHOLD", "CALLS", "MESSAGE"],
      events.map((e) => [
        when(e.created_at),
        trunc(e.rule_name || e.rule_id || "—", 20),
        `${e.metric} = ${e.observed}`,
        `${e.comparator} ${e.threshold}`,
        e.calls_in_window ?? "—",
        trunc(e.message || "—", 36),
      ]),
    );
    out(dim(`\n  ${events.length} fired event(s)  ·  widen with --days 90 --limit 200`));
    return;
  }

  fatal(`Unknown: alerts ${sub}. Try rules | rules add|update|delete|test | options | events.`);
}
