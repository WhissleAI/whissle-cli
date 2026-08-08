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

/** Where this conversation shows up in the studio. Exported for tests. */
export function sessionsUrl(studioUrl, agentId) {
  return `${(studioUrl || "").replace(/\/+$/, "")}/agents/${agentId}/calls`;
}

export async function run(sub, args, flags) {
  // `whissle chat <id>` — sub is the agent id here (no subcommands).
  const agentId = sub;
  if (!agentId) fatal("Usage: whissle chat <agent-id>   (find ids with `whissle agents list`)");

  const agent = await get(EP.agents.get(agentId)).catch(() => null);
  if (!agent) fatal(`Agent ${agentId} not found in this workspace.`);

  const cfg = loadConfig();
  let sessionId = newSessionId();

  // One-shot mode: `whissle chat <id> -m "message"` (scriptable).
  if (flags.m || flags.message) {
    const stop = spinner("thinking…");
    const r = await post(
      EP.agents.chatTurn(agentId),
      turnBody({ message: flags.m || flags.message, sessionId }),
    );
    stop();
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(md(r.reply));
    return out(dim(`\nSaved to this agent's Sessions: ${sessionsUrl(cfg.studioUrl, agentId)}`));
  }

  out(brand("● ") + bold(agent.name) + dim(`  (${agent.agent_type || "general"})`));
  if (agent.greeting) out("\n" + md(agent.greeting));
  out(dim("\nType a message. /exit to quit, /reset for a fresh thread."));
  // Said up front, not at the end: a conversation you can go and read is a
  // different thing from a terminal buffer you are about to lose.
  out(dim(`This conversation is saved to ${sessionsUrl(cfg.studioUrl, agentId)}\n`));

  let conversationId = null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    process.stdout.write(brand("you › "));
  };
  prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return prompt();
    if (text === "/exit" || text === "/quit") return rl.close();
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
      if (r.tools_used?.length) out(dim("  ⚙ used: " + r.tools_used.map((t) => (typeof t === "string" ? t : t.name)).join(", ")));
      out("");
    } catch (e) {
      stop();
      err(brand("✗ ") + (e.message || e));
    }
    rl.resume();
    prompt();
  });

  await new Promise((resolve) => rl.on("close", resolve));
  out(dim("\nbye."));
}
