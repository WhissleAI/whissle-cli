// whissle integrations — the MCP connector app store (org-scoped).
//
// Connect an external MCP server (a curated card or a pasted URL), authenticate to
// it (its own OAuth, or a bearer/API-key token), then enable its tools on any agent.
// This is the "Add integration" surface shipped in the studio, exposed for scripting.
// Org-scoped: /api/orgs/{org}/integrations.
import { get, post, del, resolveOrgId } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, table, trunc, dim, printJson, printMutation, fatal } from "../ui.mjs";

// The list endpoint returns a bare array (or {integrations:[…]} defensively).
const asList = (r) => (Array.isArray(r) ? r : r?.integrations || []);
const intRow = (i) => [
  i.id,
  trunc(i.name || i.provider || "—", 22),
  i.provider || "custom",
  i.status || "—",
  i.auth_mode || "none",
];

export async function run(sub, args, flags) {
  const org = await resolveOrgId();

  if (sub === "catalog") {
    const res = await get(EP.integrations.catalog(org));
    if (flags.json) return printJson(res);
    const providers = res?.providers || [];
    table(
      ["PROVIDER", "NAME", "CATEGORY", "AUTH", "URL"],
      providers.map((p) => [
        p.provider || p.id || "—",
        trunc(p.label || p.name || "—", 20),
        trunc(p.category || "—", 16),
        p.auth_mode || (p.oauth ? "oauth" : "—"),
        trunc(p.server_url || p.url || "", 32),
      ]),
    );
    out(dim(`\n  ${providers.length} curated provider(s) · OAuth ${res?.oauth_available ? "available" : "not configured"}`));
    return;
  }

  if (!sub || sub === "list") {
    const res = await get(EP.integrations.list(org));
    if (flags.json) return printJson(res);
    const rows = asList(res);
    table(["ID", "NAME", "PROVIDER", "STATUS", "AUTH"], rows.map(intRow));
    out(dim(`\n  ${rows.length} integration(s)`));
    return;
  }

  if (sub === "add") {
    if (!flags.name || !flags.url) {
      fatal(
        'Usage: whissle integrations add --name "<n>" --url <mcp-server-url>\n' +
          "  [--auth-mode oauth|bearer|apikey|none] [--token <t>] [--provider custom]\n" +
          "  [--header Authorization] [--prefix Bearer]\n" +
          "  bearer/apikey require --token. oauth: connect afterwards to authenticate.",
      );
    }
    const body = {
      provider: flags.provider || "custom",
      name: flags.name,
      server_url: flags.url,
      auth_mode: flags["auth-mode"] || "none",
    };
    if (flags.token) body.token = flags.token;
    if (flags.header) body.header = flags.header;
    if (flags.prefix) body.prefix = flags.prefix;
    const res = await post(EP.integrations.add(org), body);
    if (flags.json) return printJson(res);
    const integ = res?.integration || res || {};
    ok(`Added integration ${integ.id || ""} — ${integ.name || flags.name}`);
    if (res?.next === "oauth") {
      out(dim(`  Authenticate: whissle integrations connect ${integ.id} --oauth`));
    } else if (integ.status === "connected") {
      out(dim(`  Connected. Attach it: whissle integrations attach ${integ.id} --agent <agent-id>`));
    } else {
      out(dim(`  Test the connection: whissle integrations connect ${integ.id}`));
    }
    return;
  }

  if (sub === "connect") {
    const id = args[0] || fatal("Usage: whissle integrations connect <id> [--oauth]");
    // OAuth integrations authenticate via a browser redirect: start the flow and
    // print the authorize URL for the user to open. Everything else re-handshakes.
    let oauth = flags.oauth;
    if (!oauth) {
      // Auto-detect: an oauth integration needs the redirect flow, not /connect.
      const match = asList(await get(EP.integrations.list(org))).find((i) => i.id === id);
      if (match && (match.auth_mode || "").toLowerCase() === "oauth") oauth = true;
    }
    if (oauth) {
      const res = await post(EP.integrations.oauthStart(org, id), {});
      if (flags.json) return printJson(res);
      ok("Open this URL in your browser to authenticate:");
      out("\n  " + (res?.authorize_url || dim("(no URL returned)")));
      out(dim("\n  After you approve, the integration connects automatically."));
      return;
    }
    const res = await post(EP.integrations.connect(org, id), {});
    if (flags.json) return printJson(res);
    const status = res?.status || "unknown";
    if (status === "connected") ok(`Connected — ${(res?.tool_manifest || res?.tools || []).length} tool(s) discovered`);
    else fatal(`Connection ${status}: ${res?.detail || "handshake failed"}`);
    return;
  }

  if (sub === "attach") {
    const id = args[0] || fatal("Usage: whissle integrations attach <id> --agent <agent-id>");
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    const r = await post(EP.integrations.attach(org, id), { agent_id: flags.agent });
    if (flags.json) return printMutation(r, { attached: id, agent_id: flags.agent });
    ok(`Attached integration ${id} → agent ${flags.agent} (its tools are now available)`);
    return;
  }

  if (sub === "detach") {
    const id = args[0] || fatal("Usage: whissle integrations detach <id> --agent <agent-id>");
    if (!flags.agent) fatal("--agent <agent-id> is required.");
    const r = await post(EP.integrations.detach(org, id), { agent_id: flags.agent });
    if (flags.json) return printMutation(r, { detached: id, agent_id: flags.agent });
    ok(`Detached integration ${id} from agent ${flags.agent}`);
    return;
  }

  if (sub === "remove") {
    const id = args[0] || fatal("Usage: whissle integrations remove <id>");
    const r = await del(EP.integrations.remove(org, id));
    if (flags.json) return printMutation(r, { removed: id });
    ok(`Removed integration ${id}`);
    return;
  }

  fatal(`Unknown: integrations ${sub}. Try catalog | list | add | connect | attach | detach | remove.`);
}
