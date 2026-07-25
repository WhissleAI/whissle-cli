// whissle chat <agent-id>  — an interactive TEXT conversation with an agent.
// (Voice runs over WebRTC in the browser SDK, @whissle/agents; this is the
// terminal-native way to test/drive an agent's brain + tools.)
import { createInterface } from "node:readline";
import { get, post } from "../api.mjs";
import { out, err, ok, md, dim, brand, bold, spinner, fatal } from "../ui.mjs";

export async function run(sub, args, flags) {
  // `whissle chat <id>` — sub is the agent id here (no subcommands).
  const agentId = sub;
  if (!agentId) fatal("Usage: whissle chat <agent-id>   (find ids with `whissle agents list`)");

  const agent = await get(`/api/agents/${agentId}`).catch(() => null);
  if (!agent) fatal(`Agent ${agentId} not found in this workspace.`);

  // One-shot mode: `whissle chat <id> -m "message"` (scriptable).
  if (flags.m || flags.message) {
    const stop = spinner("thinking…");
    const r = await post(`/api/agents/${agentId}/chat/turn`, { message: flags.m || flags.message });
    stop();
    if (flags.json) return out(JSON.stringify(r, null, 2));
    return out(md(r.reply));
  }

  out(brand("● ") + bold(agent.name) + dim(`  (${agent.agent_type || "general"})`));
  if (agent.greeting) out("\n" + md(agent.greeting));
  out(dim("\nType a message. /exit to quit, /reset for a fresh thread.\n"));

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
      ok("New thread.");
      return prompt();
    }
    rl.pause();
    const stop = spinner("thinking…");
    try {
      const r = await post(`/api/agents/${agentId}/chat/turn`, {
        message: text,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      });
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
