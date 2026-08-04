// whissle compliance — calling compliance (org-scoped /api/orgs/{org}/compliance).
//
// Three surfaces: the Do-Not-Call list (suppressions — also written automatically by
// the `stop_calling` post-call tool), the rules the dial engine enforces (settings:
// calling window, consent, disclosure, retention), and the evidence trail (events:
// what the rules actually DID — blocked dials, disclosures, erasures).
// Enforcement happens pre-dial on the backend; this is the audit + control surface.
// Needs compliance:read; write ops need compliance:write (owner/admin).
import { readFileSync } from "node:fs";
import { get, post, put, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, kv, trunc, dim, printJson, fatal } from "../ui.mjs";

const when = (s) => (s || "").slice(0, 16).replace("T", " ");

// --flag → settings field. Booleans accept an explicit true/false value or a bare flag.
const SETTING_FLAGS = {
  "window-start": ["calling_window_start", "int"],
  "window-end": ["calling_window_end", "int"],
  timezone: ["default_timezone", "str"],
  "require-consent": ["require_consent_for_autonomous", "bool"],
  "disclosure-required": ["disclosure_required", "bool"],
  "disclosure-text": ["disclosure_text", "str"],
  "retention-days": ["retention_days", "int"],
};

function settingsBody(flags) {
  const body = {};
  for (const [flag, [field, type]] of Object.entries(SETTING_FLAGS)) {
    const v = flags[flag];
    if (v === undefined) continue;
    if (type === "int") body[field] = parseInt(v, 10);
    else if (type === "bool") body[field] = v === true || String(v).toLowerCase() === "true";
    else body[field] = String(v);
  }
  return body;
}

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "suppressions") {
    // args[0] may be a redundant "list" — tolerated, it's the only verb here.
    const rows = await get(EP.compliance.suppressions(org));
    if (flags.json) return printJson(rows);
    table(
      ["PHONE", "REASON", "SOURCE", "WHEN"],
      (rows || []).map((s) => [
        s.phone_number || "—", trunc(s.reason || "—", 30), s.source || "—", when(s.suppressed_at),
      ]),
    );
    out(dim(`\n  ${(rows || []).length} suppressed number(s)  ·  whissle compliance suppress <+1…> | unsuppress <+1…>`));
    return;
  }

  if (sub === "suppress") {
    const phone = args[0] || fatal('Usage: whissle compliance suppress <+1…> [--reason "…"]   (add to the Do-Not-Call list)');
    const res = await post(EP.compliance.suppressions(org), {
      phone_number: phone,
      ...(typeof flags.reason === "string" ? { reason: flags.reason } : {}),
    });
    if (flags.json) return printJson(res);
    ok(`Suppressed ${res.phone_number || phone} — it will not be dialed`);
    return;
  }

  if (sub === "unsuppress") {
    const phone = args[0] || fatal("Usage: whissle compliance unsuppress <+1…>   (re-enable calling for a number)");
    await del(EP.compliance.suppression(org, encodeURIComponent(phone)));
    ok(`Re-enabled calling for ${phone}`);
    return;
  }

  if (sub === "settings") {
    if (args[0] === "set") {
      const body = flags.file ? JSON.parse(readFileSync(flags.file, "utf8")) : settingsBody(flags);
      if (!Object.keys(body).length) {
        fatal("settings set needs --file settings.json or at least one of: " +
          Object.keys(SETTING_FLAGS).map((f) => `--${f}`).join(" "));
      }
      const s = await put(EP.compliance.settings(org), body);
      if (flags.json) return printJson(s);
      ok("Updated compliance settings");
      kv(s);
      return;
    }
    const s = await get(EP.compliance.settings(org)); // never-configured orgs get SAFE defaults
    if (flags.json) return printJson(s);
    kv(s);
    out(dim("\n  change them: whissle compliance settings set --window-start 9 --window-end 20 --timezone America/New_York …"));
    return;
  }

  if (sub === "events") {
    const res = await get(EP.compliance.events(org), { query: { days: flags.days, limit: flags.limit } });
    if (flags.json) return printJson(res);
    const summary = res?.summary || [];
    if (summary.length) {
      out(dim(`  last ${res.days} day(s):`));
      table(["EVENT", "REASON", "COUNT"], summary.map((s) => [s.event_type, trunc(s.reason || "—", 30), s.count]));
      out("");
    }
    table(
      ["WHEN", "EVENT", "REASON", "CHANNEL", "PHONE"],
      (res?.events || []).map((e) => [
        when(e.created_at), e.event_type || "—", trunc(e.reason || "—", 24), e.channel || "—", e.phone_number || "—",
      ]),
    );
    out(dim(`\n  ${(res?.events || []).length} event(s)  ·  widen with --days 90 --limit 200`));
    return;
  }

  fatal(`Unknown: compliance ${sub}. Try suppressions | suppress | unsuppress | settings | settings set | events.`);
}
