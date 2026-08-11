// whissle login | config | whoami
import { createInterface } from "node:readline/promises";
import { loadConfig, saveConfig, configPath, DEFAULT_BASE_URL } from "../config.mjs";
import { whoami } from "../api.mjs";
import { EXIT, exitCodeFor } from "../exit.mjs";
import { out, err, ok, kv, dim, bold, brand, spinner, printJson } from "../ui.mjs";

async function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) rl.output.write = () => {}; // don't echo secrets
  const answer = await rl.question(question);
  rl.close();
  if (hidden) out("");
  return answer.trim();
}

export async function run(sub, args, flags) {
  if (sub === "login") {
    out(brand("Whissle") + " — connect your workspace\n");
    out(dim("Create a workspace secret key in Settings → API keys on platform.whissle.ai.\n"));
    const key = flags.key || (await ask("Paste your secret key (wsk_…): ", { hidden: true }));
    if (!key.startsWith("wsk_")) out(dim("(heads up: a workspace secret key starts with wsk_)"));
    const baseUrl = flags["base-url"] || DEFAULT_BASE_URL;
    saveConfig({ apiKey: key, baseUrl, orgId: null });
    // Verify + resolve the workspace.
    const stop = spinner("verifying key…");
    try {
      const me = await whoami();
      stop();
      const org = me?.organization;
      if (org?.id) saveConfig({ orgId: org.id });
      ok(`Connected${org ? ` to ${bold(org.name || org.slug || org.id)}` : ""}.`);
      out(dim(`Key stored in ${configPath} (0600).`));
    } catch (e) {
      stop();
      throw e;
    }
    return;
  }

  if (sub === "logout") {
    saveConfig({ apiKey: null, orgId: null });
    ok("Signed out — key removed from " + configPath);
    return;
  }

  if (sub === "whoami") {
    // `whoami` is the ONE command whose job is "is my key valid?". It used to
    // swallow the auth failure and fall through to the CACHED workspace id, so a
    // revoked key printed a workspace and exited 0 — the single most misleading
    // thing this CLI could do. The failure is now the answer.
    const cfg = loadConfig();
    if (!cfg.apiKey) {
      if (flags.json) printJson({ base_url: cfg.baseUrl, ok: false, error: "not logged in" });
      else err(brand("✗ ") + "Not logged in. Run `whissle login`.");
      return process.exit(EXIT.AUTH);
    }
    let me;
    try {
      me = await whoami();
    } catch (e) {
      if (!flags.json) throw e; // the top-level handler prints it + maps the code
      printJson({
        base_url: cfg.baseUrl, ok: false,
        error: e?.message || String(e), status: e?.status ?? null,
      });
      return process.exit(exitCodeFor(e));
    }
    const org = me?.organization;
    if (flags.json) return printJson({ base_url: cfg.baseUrl, ok: true, ...me });
    kv(
      {
        workspace: org ? org.name || org.slug || org.id : dim("(unresolved)"),
        workspace_id: org?.id || cfg.orgId,
        role: me?.role || dim("—"),
        key: cfg.apiKey.slice(0, 10) + "…",
        gateway: cfg.baseUrl,
      },
      ["workspace", "workspace_id", "role", "key", "gateway"],
    );
    return;
  }

  // `whissle config` — show or set.
  if (sub === "set") {
    const patch = {};
    if (flags.key) patch.apiKey = flags.key;
    if (flags["base-url"]) patch.baseUrl = flags["base-url"];
    saveConfig(patch);
    return ok("Saved.");
  }
  // default: show
  const cfg = loadConfig();
  kv(
    { gateway: cfg.baseUrl, key: cfg.apiKey ? cfg.apiKey.slice(0, 10) + "…" : dim("(none)"), workspace_id: cfg.orgId || dim("(unresolved)"), config: configPath },
    ["gateway", "key", "workspace_id", "config"],
  );
}
