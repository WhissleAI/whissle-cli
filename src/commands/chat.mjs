// whissle chat <agent-id>  — an interactive TEXT conversation with an agent.
// (Voice runs over WebRTC in the browser SDK, @whissle/agents; this is the
// terminal-native way to test/drive an agent's brain + tools.)
//
// Every turn goes through POST /api/agents/{id}/chat/turn, which PERSISTS the
// conversation — so a CLI session is real history, not a scratch pad. Two things
// make that history legible in the studio's Sessions tab:
//
//   * `source: "cli"` — the origin stamp. Without it a CLI run, an n8n step and
//     a partner backend are indistinguishable: same org key, same endpoint.
//   * `session_id` — a fresh id per invocation, so THIS run is its own session
//     row instead of being appended to one ever-growing thread per API key.
//
// Both are optional on the server; an older gateway ignores them and behaves
// exactly as it did before.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { get, post } from "../api.mjs";
import { loadConfig } from "../config.mjs";
import { EP } from "../endpoints.mjs";
import { out, err, ok, md, dim, brand, bold, spinner, fatal } from "../ui.mjs";
import { turnFooterLines } from "../turn.mjs";

/** A new per-run session key. Exported for tests. */
export function newSessionId() {
  return randomUUID();
}

/**
 * The turn body. `conversation_id` (once the server has given us one) is the
 * authoritative thread handle; `session_id` is what the FIRST turn uses to open
 * a thread of its own. Exported for tests.
 */
export function turnBody({ message, conversationId, sessionId }) {
  return {
    message,
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    source: "cli",
  };
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

export async function run(sub, args, flags) {
  // `whissle chat <id>` — sub is the agent id here (no subcommands).
  const agentId = sub;
  if (!agentId) fatal("Usage: whissle chat <agent-id>   (find ids with `whissle agents list`)");

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

  // One-shot mode: `whissle chat <id> -m "message"` (scriptable).
  if (flags.m || flags.message) {
    const stop = spinner("thinking…");
    const r = await post(
      EP.agents.chatTurn(agentId),
      // A resumed thread is addressed by conversation_id; only an OPENING turn
      // carries the session key (it is what names the new session row).
      turnBody({
        message: flags.m || flags.message,
        conversationId,
        sessionId: conversationId ? null : sessionId,
      }),
    );
    stop();
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(md(r.reply));
    for (const l of turnFooterLines(r, { verbose: flags.verbose, showTools: flags.tools })) out(l);
    if (r.conversation_id) out(dim(`\n  continue: --conversation ${r.conversation_id}`));
    return out(dim(`  saved to this agent's Sessions: ${sessionsUrl(cfg.studioUrl, agentId)}`));
  }

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
    const stop = spinner("thinking…");
    try {
      const r = await post(
        EP.agents.chatTurn(agentId),
        turnBody({ message: text, conversationId, sessionId }),
      );
      stop();
      conversationId = r.conversation_id || conversationId;
      out("\n" + brand(agent.name + " › ") + md(r.reply));
      // The turn already carried its tool timeline and its KB citations; the CLI
      // used to print the tool NAMES and throw both away. A cited answer whose
      // citations you cannot see is indistinguishable from an uncited one.
      for (const l of turnFooterLines(r, { verbose: flags.verbose, showTools: flags.tools })) out(l);
      out("");
    } catch (e) {
      stop();
      err(brand("✗ ") + (e.message || e));
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
