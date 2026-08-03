// whissle customers — end-customer / contact records (/api/customers).
//
// NOT org-prefixed: the key resolves the org (needs contacts:read / contacts:write).
// Contacts are agent-scoped on this platform — every contact belongs to exactly one
// agent, so create + import require --agent.
import { readFileSync } from "node:fs";
import { get, post, patch, del, upload } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, kv, table, trunc, dim, printJson, fatal } from "../ui.mjs";

// Real customer columns the backend maps to typed fields; anything else in a CSV
// becomes a custom attribute. Kept in sync with routes/customers.py _CUSTOMER_COLUMNS.
const KNOWN_COLUMNS = new Set([
  "name", "phone_number", "email", "notes", "due_amount", "merchant_name",
  "days_overdue", "preferred_language", "product_name", "due_date",
  "total_amount_due", "purchase_amount",
]);

// Minimal CSV header parse — first line, comma-split, strip quotes/BOM/whitespace.
function csvHeaders(text) {
  const first = text.replace(/^﻿/, "").split(/\r?\n/)[0] || "";
  return first.split(",").map((h) => h.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

const custRow = (c) => [
  c.id,
  trunc(c.name, 22),
  c.phone_number || c.phone || "—",
  trunc(c.email || "", 24),
  c.call_count ?? 0,
];

export async function run(sub, args, flags) {
  if (!sub || sub === "list") {
    const res = await get(EP.customers.list, {
      query: { limit: flags.limit, agent_id: flags.agent },
    });
    if (flags.json) return printJson(res);
    const rows = Array.isArray(res) ? res : res?.customers || [];
    table(["ID", "NAME", "PHONE", "EMAIL", "CALLS"], rows.map(custRow));
    out(dim(`\n  ${rows.length} contact(s)`));
    return;
  }

  if (sub === "get") {
    const id = args[0] || fatal("Usage: whissle customers get <id>");
    const c = await get(EP.customers.get(id));
    if (flags.json) return printJson(c);
    kv(c, ["id", "name", "phone_number", "email", "notes", "preferred_language", "agent_id", "call_count", "created_at"]);
    return;
  }

  if (sub === "create") {
    if (!flags.name || !flags.phone) {
      fatal(
        'Usage: whissle customers create --name "<n>" --phone <+1…> --agent <agent-id> [--email e] [--notes n]\n' +
          "  Contacts belong to an agent, so --agent is required.",
      );
    }
    if (!flags.agent) fatal("--agent <agent-id> is required — contacts belong to an agent.");
    const body = { name: flags.name, phone_number: flags.phone, agent_id: flags.agent };
    if (flags.email) body.email = flags.email;
    if (flags.notes) body.notes = flags.notes;
    if (flags.language) body.preferred_language = flags.language;
    const c = await post(EP.customers.create, body);
    if (flags.json) return printJson(c);
    ok(`Created contact ${c.id} — ${c.name} (${c.phone_number})`);
    return;
  }

  if (sub === "import") {
    if (!flags.file || !flags.agent) {
      fatal(
        "Usage: whissle customers import --file contacts.csv --agent <agent-id>\n" +
          "  [--on-duplicate skip|update] [--map CsvCol=target ...]\n" +
          "  The CSV needs a phone_number column (or --map YourCol=phone_number).\n" +
          "  Each header maps to itself by default; unknown columns become custom attributes.",
      );
    }
    // Build a column→target mapping the backend expects (multipart Form field).
    // Default: identity for every CSV header. --map overrides let a differently
    // named column point at a real field (e.g. --map Mobile=phone_number).
    const text = readFileSync(flags.file, "utf8");
    const headers = csvHeaders(text);
    if (!headers.length) fatal("Could not read any header row from the CSV.");
    const mapping = {};
    for (const h of headers) mapping[h] = KNOWN_COLUMNS.has(h) ? h : h;
    for (const m of [].concat(flags.map || [])) {
      if (typeof m !== "string" || !m.includes("=")) continue;
      const [col, target] = m.split("=");
      mapping[col.trim()] = target.trim();
    }
    if (!Object.values(mapping).includes("phone_number")) {
      fatal(
        "No column maps to phone_number. Add a phone_number header, or pass\n" +
          "  --map <YourPhoneColumn>=phone_number",
      );
    }
    const res = await upload(EP.customers.import, {
      filePath: flags.file,
      fields: {
        agent_id: flags.agent,
        mapping: JSON.stringify(mapping),
        on_duplicate: flags["on-duplicate"] || "skip",
      },
    });
    if (flags.json) return printJson(res);
    ok(`Import complete — created ${res.created}, updated ${res.updated}, skipped ${res.skipped}`);
    for (const e of (res.errors || []).slice(0, 10)) out(dim(`  row ${e.row}: ${e.reason}`));
    if ((res.errors || []).length > 10) out(dim(`  …and ${res.errors.length - 10} more`));
    return;
  }

  if (sub === "update") {
    const id = args[0] || fatal("Usage: whissle customers update <id> --<field> <value> (e.g. --name, --phone, --email, --notes)");
    const body = {};
    if (flags.name) body.name = flags.name;
    if (flags.phone) body.phone_number = flags.phone;
    if (flags.email) body.email = flags.email;
    if (flags.notes) body.notes = flags.notes;
    if (flags.language) body.preferred_language = flags.language;
    if (!Object.keys(body).length) fatal("Nothing to update — pass at least one of --name / --phone / --email / --notes / --language.");
    const c = await patch(EP.customers.update(id), body);
    if (flags.json) return printJson(c);
    ok(`Updated contact ${c.id} — ${c.name}`);
    return;
  }

  if (sub === "delete") {
    const id = args[0] || fatal("Usage: whissle customers delete <id>");
    await del(EP.customers.del(id));
    ok(`Deleted contact ${id} (and its calls + recordings)`);
    return;
  }

  fatal(`Unknown: customers ${sub}. Try list | get | create | import | update | delete.`);
}
