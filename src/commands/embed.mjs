// whissle embed show|enable|disable|token
// Make an agent embeddable as a voice widget on a website. The SAME agent can
// also take phone calls (`whissle numbers connect`) — one agent, every channel.
// Needs agents:read / agents:write.
//
// `token` is the other half: show/enable/disable CONFIGURE the widget, token
// STARTS a session. It's the primitive a partner backend calls per visitor —
// mint server-side with the secret key, hand the browser the short-lived token,
// and the key never leaves the server.
import { get, patch, post } from "../api.mjs";
import { loadConfig } from "../config.mjs";
import { EP } from "../endpoints.mjs";
import { out, ok, kv, dim, bold, printJson, printMutation, fatal } from "../ui.mjs";

/**
 * The mint body. The credential goes in the BODY as `api_key` (not only the
 * bearer header) — the mint is a PUBLIC route that accepts either a key or a
 * per-agent embed_key, so it reads the credential from the payload.
 * Exported for tests.
 */
export function sessionBody(cfg, agentId) {
  return { api_key: cfg.apiKey, agent_id: agentId };
}

/**
 * The avatar code from `--avatar`, or null when the flag was not given.
 *
 * A bare `--avatar` parses to boolean `true`. That used to be read as "no
 * avatar" and SILENTLY skipped the mint — the user asked for an avatar, got a
 * plain session, and nothing said why. It is a usage error, so it errors.
 * Exported for tests.
 */
export function avatarCode(flag) {
  if (flag === undefined || flag === null || flag === false) return null;
  // Repeated `--avatar a --avatar b` collects into an array; the last wins.
  const value = Array.isArray(flag) ? flag[flag.length - 1] : flag;
  if (value === true || String(value).trim() === "") {
    fatal("--avatar needs an avatar code, e.g. --avatar F1-HR. Codes: F1-HR F2-TL F3-SE M1-HR M2-TL M3-SE.");
  }
  return String(value).trim();
}

/** Where the browser takes the minted token. Exported for tests. */
export function openUrls(baseUrl) {
  return { voice: `${baseUrl}${EP.embed.offer}`, text: `${baseUrl}${EP.embed.chatTurn}` };
}

/**
 * The connect hints, derived from the mint response's `transport` descriptor —
 * the server SAYS which transport to use and where its credentials come from,
 * and hardcoding /api/embed/offer here sent every integrator to the fallback
 * even when the gateway advertised a better door. Descriptor paths may be
 * relative (the default: the client already knows the host + prefix it reached
 * the mint through), so absolutize against the configured base URL; `auth:
 * "query:token"` means the session token rides the query string. A gateway old
 * enough to mint without a descriptor gets the previous hardcoded hints.
 * Pure — exported for tests. Returns [{label, method, url, note}].
 */
export function connectHints(transport, baseUrl) {
  if (!transport || typeof transport !== "object") {
    const urls = openUrls(baseUrl);
    return [
      { label: "voice", method: "POST", url: `${urls.voice}?token=<token>`, note: "SDP offer" },
      { label: "text", method: "POST", url: urls.text, note: "{token, message}" },
    ];
  }
  const abs = (u) => (u && !/^[a-z]+:\/\//i.test(u) ? `${baseUrl}${u}` : u || "");
  const door = (d) => ({
    method: d?.method || "POST",
    url: abs(d?.url) + (d?.auth === "query:token" ? "?token=<token>" : ""),
  });
  const hints = [];
  for (const t of [transport, ...(transport.fallbacks || [])]) {
    if (!t?.connect) continue;
    const fallback = t === transport ? "" : " (fallback)";
    const note =
      t.kind === "livekit"
        ? `returns {url, token, room} — join the room${t.url ? ` at ${t.url}` : ""}`
        : "SDP offer" + (t.trickle_ice ? `; trickle ICE: ${door(t.trickle_ice).method} same door` : "");
    hints.push({ label: `voice · ${t.kind || "webrtc"}${fallback}`, ...door(t.connect), note });
  }
  if (transport.text?.connect) {
    hints.push({ label: "text", ...door(transport.text.connect), note: "{token, message}" });
  }
  return hints.length ? hints : connectHints(null, baseUrl);
}

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
  // Wire-your-own-UI path. `@whissle/agents` IS published now, so point at the
  // real install command (it used to say "publishing shortly", which stopped
  // being true and sent integrators looking for a package they already had).
  out("\n  " + dim("Or wire it into your own UI with the browser SDK + a publishable (wpk_) key:"));
  out(dim("    npm i @whissle/agents"));
  out(dim("    WhissleAgents.mount('#el', { apiKey: 'wpk_…', agentId: '<id>' })"));
  out(dim("    docs: github.com/WhissleAI/agents_js_sdk  ·  npm: @whissle/agents"));
}

export async function run(sub, args, flags) {
  const id = args[0] || fatal("Usage: whissle embed <show|enable|disable|token> <agent-id>");

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
    const cfg = await patch(EP.agents.embed(id), { embed_enabled: false });
    if (flags.json) return printMutation(cfg, { agent_id: id, embed_enabled: false });
    ok(`Embedding disabled for agent ${id}.`);
    return;
  }

  if (sub === "token") {
    // Mint a short-lived session token for one visitor. The secret key makes it
    // SERVER-TRUSTED: no origin is baked into the token, so the browser can open
    // the session from any origin and it stays reusable for its TTL (a dropped
    // media connection can reconnect). The agent must still be embed-enabled.
    const cfg = loadConfig();
    const session = await post(EP.embed.sessionToken, sessionBody(cfg, id));

    // Optionally chain the browser-direct avatar mint, so the page renders the
    // avatar itself and our node does zero video codec. Authed by the session
    // token we just minted — same credential the offer uses.
    let avatar = null;
    const avatarId = avatarCode(flags.avatar);
    if (avatarId) {
      avatar = await post(EP.embed.simliToken, undefined, {
        query: { token: session.token, avatar_id: avatarId },
      });
    }

    if (flags.json) return printJson(avatar ? { ...session, avatar } : session);

    out(bold("Embed session") + dim(` — agent ${id}`));
    kv(
      {
        agent: session.agent?.name || dim("(unnamed)"),
        expires_in: `${session.expires_in}s`,
        surface: session.text_enabled ? "voice + text" : "voice",
        token: session.token,
      },
      ["agent", "expires_in", "surface", "token"],
    );
    if (avatar) {
      out("\n  " + dim("avatar (browser-rendered):"));
      kv({ face_id: avatar.face_id, session_token: avatar.session_token });
    }
    // The hints come from the mint's own `transport` descriptor — what the
    // server says to use, not what this CLI version happens to remember.
    const hints = connectHints(session.transport, cfg.baseUrl);
    out("\n  " + dim("Open the session from your page:"));
    for (const h of hints) {
      out(dim(`    ${h.label.padEnd(Math.max(...hints.map((x) => x.label.length)))}  ${h.method} ${h.url}   (${h.note})`));
    }
    return;
  }

  fatal(`Unknown: embed ${sub}. Try show | enable | disable | token.`);
}
