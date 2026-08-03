// whissle embed show|enable|disable
// Make an agent embeddable as a voice widget on a website. The SAME agent can
// also take phone calls (`whissle numbers connect`) — one agent, every channel.
// Needs agents:read / agents:write.
import { get, patch } from "../api.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, kv, dim, bold, printJson, fatal } from "../ui.mjs";

function show(cfg) {
  if (!cfg.embed_enabled) {
    out(dim("  Embedding is OFF. Turn it on: ") + "whissle embed enable <agent-id> --origin https://yoursite.com");
    return;
  }
  kv(
    { enabled: "yes", embed_key: cfg.embed_key, allowed_origins: (cfg.allowed_origins || []).join(", ") || dim("(none)"), text_mode: cfg.text_enabled ? "text widget" : "voice widget" },
    ["enabled", "embed_key", "allowed_origins", "text_mode"],
  );
  if (cfg.snippet) {
    out("\n  " + dim("Paste this on your site:"));
    out("  " + cfg.snippet);
  }
  out("\n  " + dim("Or wire it into your own UI with @whissle/agents + a publishable (wpk_) key:"));
  out(dim("    npm i @whissle/agents  →  WhissleAgents.mount('#el', { apiKey: 'wpk_…', agentId: '<id>' })"));
}

export async function run(sub, args, flags) {
  const id = args[0] || fatal("Usage: whissle embed <show|enable|disable> <agent-id>");

  if (!sub || sub === "show") {
    const cfg = await get(EP.agents.embed(id));
    if (flags.json) return printJson(cfg);
    out(bold("Web embed") + dim(` — agent ${id}`));
    return show(cfg);
  }

  if (sub === "enable") {
    // Origins may repeat (--origin a --origin b) or be comma-separated.
    const raw = [].concat(flags.origin || []).flatMap((o) => String(o).split(","));
    const origins = raw.map((s) => s.trim()).filter(Boolean);
    if (!origins.length) {
      fatal("Add at least one site: whissle embed enable <agent-id> --origin https://yoursite.com");
    }
    const cfg = await patch(EP.agents.embed(id), {
      embed_enabled: true,
      allowed_origins: origins,
      ...(flags.text ? { text_enabled: true } : {}),
    });
    if (flags.json) return printJson(cfg);
    ok(`Embedding enabled for ${origins.join(", ")}.`);
    return show(cfg);
  }

  if (sub === "disable") {
    await patch(EP.agents.embed(id), { embed_enabled: false });
    ok(`Embedding disabled for agent ${id}.`);
    return;
  }

  fatal(`Unknown: embed ${sub}. Try show | enable | disable.`);
}
