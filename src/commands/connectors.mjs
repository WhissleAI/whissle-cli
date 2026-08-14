// whissle connectors list|add|remove — org connectors (stored credentials).
//
// A connector is a named, reusable credential the workspace holds for an external
// system (a FHIR/EHR server, an EHR OAuth app, …). Once a `fhir` connector exists,
// agents built with `whissle agents create --file …` can call the `fhir_*` tools
// without anyone pasting secrets into a prompt. Org-scoped: /api/orgs/{org}/credentials.
import { readFileSync } from "node:fs";
import { get, post, patch, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";
import { exitCodeFor } from "../exit.mjs";

// The LIST endpoint may return {credentials:[…]} or a bare array — accept both.
const asList = (r) => (Array.isArray(r) ? r : r?.credentials || []);

// Assemble a connector config from typed flags (primarily for FHIR). Only the
// flags actually provided are included, so the body stays minimal.
function configFromFlags(flags) {
  const cfg = {};
  if (flags["base-url"]) cfg.base_url = flags["base-url"];
  if (flags.auth) cfg.auth = flags.auth;
  if (flags.token) cfg.token = flags.token;
  if (flags["token-url"]) cfg.token_url = flags["token-url"];
  if (flags["client-id"]) cfg.client_id = flags["client-id"];
  if (flags["client-secret"]) cfg.client_secret = flags["client-secret"];
  return cfg;
}

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (!sub || sub === "list") {
    const res = await get(EP.connectors.list(org), {
      query: { kind: flags.kind || undefined },
    });
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(
      ["ID", "KIND", "NAME"],
      rows.map((c) => [c.id, c.kind || "—", trunc(c.name, 40)]),
    );
    out(dim(`\n  ${rows.length} connector(s)`));
    return;
  }

  if (sub === "add") {
    if (!flags.kind || !flags.name) {
      fatal(
        'Usage: whissle connectors add --kind <k> --name "<n>" [config…]\n' +
          "  FHIR/EHR example:\n" +
          '    whissle connectors add --kind fhir --name "Epic Sandbox" \\\n' +
          "      --base-url https://fhir.example.org/r4 \\\n" +
          "      --auth client_credentials --token-url https://auth.example.org/token \\\n" +
          "      --client-id abc --client-secret ***\n" +
          "  Auth modes: --auth none | --auth bearer --token <t> | --auth client_credentials --token-url … --client-id … --client-secret …\n" +
          "  Or pass the whole config verbatim: --config '<json>'",
      );
    }
    const config = flags.config ? JSON.parse(flags.config) : configFromFlags(flags);
    const created = await post(EP.connectors.create(org), {
      kind: flags.kind,
      name: flags.name,
      config,
    });
    if (flags.json) return printJson(created);
    ok(`Created connector ${created.id} — ${created.name} (${created.kind || flags.kind})`);
    if ((created.kind || flags.kind) === "fhir") {
      out(dim("  Agents built with `whissle agents create --file …` can now use the fhir_* tools."));
    }
    return;
  }

  if (sub === "test") {
    const id = args[0] || fatal("Usage: whissle connectors test <id>");
    // A reachable-but-rejected credential returns 200 with ok:false — not an error.
    const res = await post(EP.connectors.test(org, id));
    if (flags.json) return printJson(res);
    if (res.ok) ok(`Connector ${id} authenticates${res.kind ? ` (${res.kind})` : ""}`);
    else fatal(`Connector ${id} failed the health check: ${res.detail || "rejected"}`);
    return;
  }

  if (sub === "update") {
    const id = args[0] || fatal("Usage: whissle connectors update <id> --file connector.json");
    if (!flags.file) fatal("--file connector.json is required (fields: name / config / is_active).");
    const body = JSON.parse(readFileSync(flags.file, "utf8"));
    const updated = await patch(EP.connectors.update(org, id), body);
    if (flags.json) return printJson(updated);
    ok(`Updated connector ${id}`);
    return;
  }

  if (sub === "remove") {
    const id = args[0] || fatal("Usage: whissle connectors remove <id> [--force]");
    let r;
    try {
      r = await del(EP.connectors.del(org, id), {
        query: { confirm: flags.force ? "true" : undefined },
      });
    } catch (e) {
      // Better wording must not cost the status: `exitCodeFor` is what keeps a
      // 404 exiting 3 and a 401 exiting 2 after we have caught the error to
      // rephrase it.
      if (e.status === 404) {
        fatal(`No connector ${id} in this workspace (already removed?).`, exitCodeFor(e));
      }
      if (e.status === 409 && !flags.force) {
        fatal(`${e.message}\n  Re-run with --force to remove it.`, exitCodeFor(e));
      }
      throw e;
    }
    if (flags.json) return printMutation(r, { removed: id });
    ok(`Removed connector ${id}`);
    return;
  }

  fatal(`Unknown: connectors ${sub}. Try list | add | test | update | remove.`);
}
