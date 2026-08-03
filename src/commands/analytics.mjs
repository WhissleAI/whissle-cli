// whissle analytics — call analytics over your agents (org-scoped /api/orgs/{org}/analytics).
//
// One flexible /query aggregates the calls table: a metric grouped by a dimension,
// over a rolling window (--days) or an explicit --since/--until range. `options`
// lists the valid metric/dimension keys; `charts` lists saved dashboard charts.
import { get, resolveOrgId } from "../api.mjs";
import { out, ok, table, kv, dim, printJson, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  const org = await resolveOrgId();
  const base = `/api/orgs/${org}/analytics`;

  if (!sub || sub === "query") {
    const res = await get(`${base}/query`, {
      query: {
        metric: flags.metric,        // count | avg_duration_sec | success_rate | pickup_rate | total_duration_sec
        group_by: flags["group-by"], // day | week | month | direction | status | sentiment | intent | disposition | agent_type
        agent_id: flags.agent,
        days: flags.days,
        start: flags.since,          // inclusive date, overrides --days
        end: flags.until,
      },
    });
    if (flags.json) return printJson(res);
    out(dim(`  metric=${res.metric} group_by=${res.group_by}` + (res.start ? ` ${res.start}→${res.end}` : ` last ${res.days}d`)));
    table(["BUCKET", "VALUE"], (res.data || []).map((d) => [d.bucket, d.value]));
    out(dim(`\n  Tip: whissle analytics options   (valid metrics + dimensions)`));
    return;
  }

  if (sub === "options") {
    const res = await get(`${base}/options`);
    if (flags.json) return printJson(res);
    kv(
      { metrics: (res.metrics || []).join(", "), dimensions: (res.dimensions || []).join(", "), chart_types: (res.chart_types || []).join(", ") },
      ["metrics", "dimensions", "chart_types"],
    );
    return;
  }

  if (sub === "charts") {
    const res = await get(`${base}/charts`, { query: { agent_id: flags.agent } });
    if (flags.json) return printJson(res);
    const rows = Array.isArray(res) ? res : res?.charts || [];
    table(
      ["ID", "TITLE", "METRIC", "GROUP BY", "TYPE"],
      rows.map((c) => [c.id, c.title, c.metric, c.group_by, c.chart_type]),
    );
    out(dim(`\n  ${rows.length} saved chart(s)`));
    return;
  }

  fatal(`Unknown: analytics ${sub}. Try query | options | charts.`);
}
