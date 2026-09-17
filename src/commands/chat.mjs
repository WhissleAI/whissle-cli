// whissle chat <agent-id>  — an interactive TEXT conversation with an agent.
// (Voice runs over WebRTC in the browser SDK, @whissle/agents; this is the
// terminal-native way to test/drive an agent's brain + tools.)
//
// Every turn goes through POST /api/agents/{id}/chat/turn, which PERSISTS the
// conversation — so a CLI session is real history, not a scratch pad. Two fields
// make that history legible in the studio's Sessions tab, and the server models
// and consumes both (`routes/agents.py`, `ChatTurnBody.session_id` /
// `ChatTurnBody.source`):
//
//   * `source: "cli"` — the origin stamp. Honoured for API-key callers only (a
//     browser session IS the studio and cannot relabel itself). Without it a CLI
//     run, an n8n step and a partner backend are indistinguishable: same org
//     key, same endpoint, all filed as plain `api`.
//   * `session_id` — a fresh id per invocation. The server only reaches for it
//     when it is OPENING a thread, and what it opens is keyed
//     `key:<api-key-id>:<session_id>`; with no session key that degrades to
//     `key:<api-key-id>`, i.e. ONE ever-growing thread per key, so a CLI run
//     from Tuesday and a benchmark from Friday land in the same session row.
//
// Both are optional on the server; an older gateway ignores them and behaves
// exactly as it did before.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { get, post, postStream, ApiError } from "../api.mjs";
import { loadConfig } from "../config.mjs";
import { EP } from "../endpoints.mjs";
import { out, err, ok, md, dim, brand, bold, spinner, fatal, printJson } from "../ui.mjs";
import { turnFooterLines, contractFooterLines, claimLines } from "../turn.mjs";
import { drainStream, imageDataUrl } from "./companion.mjs";

/** A new per-run session key. Exported for tests. */
export function newSessionId() {
  return randomUUID();
}

/**
 * The turn body. Exported for tests.
 *
 * BOTH handles ride on EVERY turn, and the asymmetry is the server's, not ours:
 * `conversation_id` is looked up first and wins outright when it resolves —
 * `session_id` is then never read. It is only consulted on the branch that opens
 * a NEW thread.
 *
 * Which is exactly why it must not be withheld on a turn that carries a
 * `conversation_id`. A `--conversation` id that is stale, mistyped, or from
 * another workspace does not fail the turn: the server declines to adopt it and
 * opens a thread instead — and a turn that dropped its session key opens the
 * per-key catch-all thread, which is the one outcome `session_id` exists to
 * prevent. Sending both costs nothing and is correct on every branch.
 */
export function turnBody({
  message, conversationId, sessionId, context,
  responseSchema, cite, facts, costCenter, modelTier, images,
}) {
  return {
    message,
    // Ephemeral per-turn grounding — composed UNDER the agent's own prompt + KB
    // on the server (routes/agents.py `ChatTurnBody.context`), never stored and
    // never a persona override. This is what lets a live driver (a streamer
    // copilot's rolling stream state, a dashboard snapshot) ground one reply
    // without polluting the thread. Omitted when empty, so an older gateway that
    // does not model the field behaves exactly as before. Up to 32,000 chars;
    // over that the server answers 413 with the limit and what it got.
    ...(context ? { context } : {}),
    // A JSON schema the reply must satisfy: validated server-side, one repair
    // turn, then `schema_error` + `structured: null` — never a 5xx.
    ...(responseSchema ? { response_schema: responseSchema } : {}),
    // `cite: true` makes `retrieved` present and has the model emit `claims`
    // that name the chunk each one rests on.
    ...(cite ? { cite: true } : {}),
    // Ground truth the guardrails can consult (`never_say … unless {fact}`).
    ...(facts && Object.keys(facts).length ? { facts } : {}),
    // Who pays: rides every usage row this turn writes (`usage --by cost_center`).
    ...(costCenter ? { cost_center: costCenter } : {}),
    // fast | default | complex — the response says which actually served.
    ...(modelTier ? { model_tier: modelTier } : {}),
    ...(images && images.length ? { images } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    source: "cli",
  };
}

/** The tiers a turn may ask for; the response says which one served. */
export const MODEL_TIERS = ["fast", "default", "complex"];

/**
 * `k=v` facts from repeated `--facts` flags (plus a `--facts-file`), typed
 * leniently: a value that parses as JSON (a number, true/false, a quoted
 * string, an object) is sent as that; anything else is the string. Pure —
 * exported for tests.
 */
export function parseFacts(flagValues, fileJson) {
  const facts = { ...(fileJson && typeof fileJson === "object" ? fileJson : {}) };
  for (const kv of [].concat(flagValues || [])) {
    if (typeof kv !== "string") continue;
    const i = kv.indexOf("=");
    if (i <= 0) fatal(`--facts expects key=value, got "${kv}"`);
    const key = kv.slice(0, i).trim();
    const raw = kv.slice(i + 1);
    let value = raw;
    try { value = JSON.parse(raw); } catch { /* a bare string */ }
    facts[key] = value;
  }
  return facts;
}

/**
 * Everything a turn's flags say beyond the message: the contract fields, the
 * header-borne subject, and whether to stream. Reads files eagerly so a bad
 * path fails before the first turn rather than mid-conversation. Pure given
 * `read` — exported for tests.
 */
export function turnOptions(flags, read = readFileSync) {
  const str = (k) => (typeof flags[k] === "string" && flags[k] ? flags[k] : null);
  const readJson = (path, what) => {
    try { return JSON.parse(read(path, "utf8")); }
    catch (e) { return fatal(`${what}: cannot read ${path} as JSON (${e.message})`); }
  };
  let context = str("context");
  if (str("context-file")) {
    try { context = read(flags["context-file"], "utf8"); }
    catch (e) { fatal(`--context-file: cannot read ${flags["context-file"]} (${e.message})`); }
  }
  const modelTier = str("model-tier");
  if (modelTier && !MODEL_TIERS.includes(modelTier)) {
    fatal(`--model-tier must be one of ${MODEL_TIERS.join(" | ")}, got "${modelTier}"`);
  }
  const factsFile = str("facts-file") ? readJson(flags["facts-file"], "--facts-file") : null;
  const facts = parseFacts(flags.facts, factsFile);
  return {
    context,
    responseSchema: str("schema") ? readJson(flags.schema, "--schema") : null,
    cite: flags.cite === true || String(flags.cite).toLowerCase() === "true",
    facts,
    costCenter: str("cost-center"),
    modelTier,
    images: [].concat(flags.image || []).filter((p) => typeof p === "string").map((p) => imageDataUrl(p, read)),
    // Header-borne, never in the body: free text ≤ 120 chars naming who this
    // turn is for, stamped onto its usage rows as `subject`.
    headers: { "X-Whissle-On-Behalf-Of": str("on-behalf-of") },
    stream: flags.stream === true,
  };
}

/**
 * A 413 from an over-long `context` carries the accepted shape — say it, rather
 * than "413 Payload Too Large". Pure — exported for tests.
 */
export function explainTurnError(e) {
  const b = e && e.body && typeof e.body === "object" ? e.body : null;
  if (e && e.status === 413 && b && b.max_chars != null) {
    return `context too long: ${b.got ?? "?"} chars, the limit is ${b.max_chars}. Trim --context / --context-file.`;
  }
  return e && e.message ? e.message : String(e);
}

/**
 * Render a completed turn: the reply, then what the contract fields add —
 * `structured` (or the `schema_error` that stood in for it), the `claims`
 * behind a cited answer, the tool/evidence footer, and the tier + trace id.
 */
function renderTurn(r, { verbose, showTools, tools, cite }) {
  if (r.reply || !r.structured) out(md(r.reply || dim("(no reply)")));
  if (r.structured != null) {
    out(dim("  structured:"));
    for (const l of JSON.stringify(r.structured, null, 2).split("\n")) out("  " + l);
  } else if (r.schema_error) {
    out(brand("  ✗ schema_error: ") + r.schema_error);
  }
  if (cite) for (const l of claimLines(r.claims, r.retrieved)) out(l);
  for (const l of turnFooterLines(r, { verbose, showTools, tools })) out(l);
  for (const l of contractFooterLines(r)) out(l);
}

/** One turn, streamed or buffered, honouring `--json`. Returns the payload. */
async function oneTurn(agentId, body, o, flags) {
  if (o.stream) {
    const frames = await postStream(EP.agents.chatTurnStream(agentId), body, { headers: o.headers });
    if (flags.json && flags.events) {
      for await (const f of frames) out(JSON.stringify({ event: f.event, data: f.data }));
      return null;
    }
    const payload = await drainStream(frames, {
      write: flags.json ? () => {} : (s) => process.stdout.write(s),
      hint: `whissle sessions list --agent ${agentId}`,
    });
    if (flags.json) printJson(payload);
    else renderTurn(payload, { verbose: flags.verbose, tools: "none", cite: o.cite });
    return payload;
  }
  const stop = spinner("thinking…");
  let r;
  try {
    r = await post(EP.agents.chatTurn(agentId), body, { headers: o.headers });
  } catch (e) {
    stop();
    if (e instanceof ApiError && e.status === 413) fatal(explainTurnError(e));
    throw e;
  }
  stop();
  if (flags.json) printJson(r);
  else renderTurn(r, { verbose: flags.verbose, showTools: flags.tools, cite: o.cite });
  return r;
}

/**
 * The agent descriptor, or a usable stand-in.
 *
 * This used to be a hard preflight: `GET /api/agents/{id}` and `fatal()` on any
 * failure. That made `agents:read` a de-facto requirement for chatting, so a key
 * scoped exactly `chat:invoke` — the correct, least-privilege key for a bot that
 * only ever talks — could not chat at all, and the error said "Agent not found",
 * which is the one thing that was not wrong. The lookup is a NICETY: it supplies
 * a display name and a greeting. When it fails we chat anyway and let the TURN
 * report the real problem, with the real status code behind it.
 *
 * Exported for tests.
 */
export async function describeAgent(agentId, fetchAgent) {
  try {
    const a = await fetchAgent(agentId);
    if (a && (a.name || a.id)) return { ...a, known: true };
  } catch {
    /* fall through — the turn is the authority, not this */
  }
  return { id: agentId, name: agentId, known: false };
}

/** Where this conversation shows up in the studio. Exported for tests. */
export function sessionsUrl(studioUrl, agentId) {
  return `${(studioUrl || "").replace(/\/+$/, "")}/agents/${agentId}/calls`;
}

const TURN_USAGE =
  'Usage: whissle chat turn <agent-id> -m "…" [--stream] [--schema s.json] [--cite]\n' +
  "         [--context … | --context-file f] [--facts k=v …] [--facts-file f.json]\n" +
  "         [--cost-center cc] [--model-tier fast|default|complex] [--on-behalf-of who] [--image f.png …]";

export async function run(sub, args, flags) {
  // `whissle chat <id>` — sub is the agent id. `whissle chat turn <id> -m …` is
  // the explicit one-shot form (the same flags work on both).
  const explicitTurn = sub === "turn";
  const agentId = explicitTurn ? args[0] : sub;
  if (!agentId) fatal(explicitTurn ? TURN_USAGE : "Usage: whissle chat <agent-id>   (find ids with `whissle agents list`)");
  const o = turnOptions(flags);
  if (explicitTurn && !(flags.m || flags.message) && !o.images.length) fatal(TURN_USAGE);

  const agent = await describeAgent(agentId, (id) => get(EP.agents.get(id)));

  const cfg = loadConfig();
  let sessionId = newSessionId();
  // `--conversation <id>` RESUMES a thread. Without it every invocation was a
  // stranger: one-shot never sent a conversation_id at all, so a script could
  // ask a question and could not ask a follow-up — the second turn had no idea
  // the first had happened. The id is echoed on every turn so a script can hold
  // the thread in a variable and pass it back.
  let conversationId =
    (typeof flags.conversation === "string" && flags.conversation) ||
    (typeof flags.c === "string" && flags.c) ||
    null;

  // `--context <text>` / `--context-file <path>` and the other per-turn fields
  // (see turnOptions/turnBody) are read once, up front, for every turn.
  const turnContext = o.context;

  // One-shot mode: `whissle chat <id> -m "message"` (scriptable).
  if (flags.m || flags.message || o.images.length) {
    const msg = flags.m || flags.message || "What do you make of this?";
    // Both handles, always — see `turnBody`. A resumed thread is addressed by
    // conversation_id and the session key is ignored; a `--conversation` the
    // server declines to adopt falls back to it rather than to the per-key
    // catch-all thread.
    const r = await oneTurn(agentId, turnBody({ message: msg, conversationId, sessionId, ...o }), o, flags);
    if (!r || flags.json) return;
    if (r.conversation_id) out(dim(`\n  continue: --conversation ${r.conversation_id}`));
    return out(dim(`  saved to this agent's Sessions: ${sessionsUrl(cfg.studioUrl, agentId)}`));
  }
  if (flags.json) fatal('`--json` needs a message: whissle chat <agent-id> -m "…" --json');

  out(brand("● ") + bold(agent.name) + dim(`  (${agent.agent_type || "general"})`));
  if (!agent.known) {
    // Said, not hidden: we could not read the agent record, so the header above
    // is the id rather than a name. If the id is genuinely wrong the first turn
    // will say so with the status code to prove it.
    out(dim("  (couldn't read this agent's details — needs agents:read; chatting anyway)"));
  }
  if (agent.greeting) out("\n" + md(agent.greeting));
  out(dim("\nType a message. /exit to quit, /reset for a fresh thread, /thread for the id."));
  // Said up front, not at the end: a conversation you can go and read is a
  // different thing from a terminal buffer you are about to lose.
  out(dim(`This conversation is saved to ${sessionsUrl(cfg.studioUrl, agentId)}\n`));

  if (conversationId) out(dim(`resuming conversation ${conversationId}\n`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    process.stdout.write(brand("you › "));
  };
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return prompt();
    if (text === "/exit" || text === "/quit") return rl.close();
    if (text === "/thread") {
      out(dim(conversationId ? `  --conversation ${conversationId}` : "  (no turn yet)"));
      return prompt();
    }
    if (text === "/reset") {
      conversationId = null;
      // A new thread must also be a new SESSION, or the next turn resumes the
      // one we just walked away from.
      sessionId = newSessionId();
      ok("New thread.");
      return prompt();
    }
    rl.pause();
    try {
      // The turn carries its tool timeline and its KB citations; the CLI used
      // to print the tool NAMES and throw both away. A cited answer whose
      // citations you cannot see is indistinguishable from an uncited one.
      out("\n" + brand(agent.name + " › "));
      const r = await oneTurn(agentId, turnBody({ message: text, conversationId, sessionId, ...o }), o, flags);
      conversationId = r.conversation_id || conversationId;
      out("");
    } catch (e) {
      err(brand("✗ ") + explainTurnError(e));
    }
    rl.resume();
    prompt();
  });

  await new Promise((resolve) => rl.on("close", resolve));
  out(
    dim(
      conversationId
        ? `\nbye.  (resume: whissle chat ${agentId} --conversation ${conversationId})`
        : "\nbye.",
    ),
  );
}
