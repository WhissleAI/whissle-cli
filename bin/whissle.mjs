#!/usr/bin/env node
// Whissle Voice Agents CLI — entry point.
//
// Grammar:  whissle <group> [subcommand] [positionals…] [--flags]
// Global flags: --json (machine output), --base-url <url>, --key <wsk_…>
import { ApiError } from "../src/api.mjs";
import { err, out, brand, bold, dim } from "../src/ui.mjs";

const GROUPS = {
  agents: () => import("../src/commands/agents.mjs"),
  chat: () => import("../src/commands/chat.mjs"),
  calls: () => import("../src/commands/calls.mjs"),
  kb: () => import("../src/commands/kb.mjs"),
  tools: () => import("../src/commands/tools.mjs"),
  numbers: () => import("../src/commands/numbers.mjs"),
  models: () => import("../src/commands/models.mjs"),
  usage: () => import("../src/commands/usage.mjs"),
  config: () => import("../src/commands/config.mjs"),
};
// config.mjs also serves these top-level verbs (sub = the verb itself):
const CONFIG_VERBS = new Set(["login", "logout", "whoami"]);

/** Split tokens into { positionals, flags }. Flags: --k v, --bool, -m v. */
function parse(tokens) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("-")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else if (t === "-m") {
      flags.m = tokens[++i];
    } else {
      positionals.push(t);
    }
  }
  return { positionals, flags };
}

const HELP = `${brand("whissle")} — the Voice Agents platform CLI

${bold("Setup")}
  whissle login                       connect a workspace (secret key wsk_…)
  whissle whoami                      show the connected workspace
  whissle config [set --key … --base-url …]

${bold("Configure agents")}
  whissle agents list
  whissle agents get <id>
  whissle agents create --name N --prompt P [--type customer_support] [--greeting G]
  whissle agents create --file agent.json
  whissle agents update <id> [--prompt … | --file …]
  whissle agents delete <id>

${bold("Run an agent")}
  whissle chat <agent-id>             interactive text conversation
  whissle chat <agent-id> -m "hi"     one-shot (scriptable)
  ${dim("(browser voice embed → the @whissle/agents JS SDK + a publishable wpk_ key)")}

${bold("Records & evaluation")}  ${dim("(needs calls:read)")}
  whissle calls list [--agent <id>] [--status s] [--limit N]
  whissle calls get <id>
  whissle calls transcript <id>
  whissle calls audio <id>            signed recording URL
  whissle calls export [--agent <id>] [--since 2026-07-01] [--format jsonl|csv] [--out f]

${bold("Knowledge & tools")}
  whissle kb list <agent-id>
  whissle kb add <agent-id> [--text … | --file f.pdf | --url https://…]
  whissle tools list
  whissle tools create --file tool.json
  whissle tools attach <tool-id> --agent <agent-id>

${bold("Phone numbers")}  ${dim("(needs numbers:read / numbers:write)")}
  whissle numbers list
  whissle numbers search [--country US] [--area 415] [--contains 555]
  whissle numbers buy <+1…>              buy a number (deducts credits)
  whissle numbers connect <+1…> --agent <agent-id>   route inbound to an agent
  whissle numbers release <number-id>

${bold("À-la-carte models")}  ${dim("(needs models:invoke)")}
  whissle models chat "prompt" [--system …] [--fast]
  whissle models tts "text" [--voice …] --out speech.mp3
  whissle models transcribe audio.wav [--language xx] [--diarize]

${bold("Billing")}
  whissle usage                       wallet balance + recent ledger

Global: --json (machine output), --base-url <url>, --key <wsk_…>
Docs: https://platform.whissle.ai/docs`;

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first || first === "help" || first === "-h" || first === "--help") return out(HELP);
  if (first === "version" || first === "-v" || first === "--version") {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return out("whissle " + JSON.parse(readFileSync(p, "utf8")).version);
  }

  const { positionals, flags } = parse(argv.slice(1));
  if (flags["base-url"]) process.env.WHISSLE_BASE_URL = flags["base-url"];
  if (flags.key) process.env.WHISSLE_API_KEY = flags.key;

  let group, sub, rest;
  if (CONFIG_VERBS.has(first)) {
    group = "config"; sub = first; rest = positionals;
  } else if (GROUPS[first]) {
    group = first; sub = positionals[0]; rest = positionals.slice(1);
  } else {
    err(brand("✗ ") + `Unknown command "${first}".`);
    out("\n" + HELP);
    process.exit(1);
  }

  const mod = await GROUPS[group]();
  await mod.run(sub, rest, flags);
}

main().catch((e) => {
  if (e instanceof ApiError) err(brand("✗ ") + e.message);
  else err(brand("✗ ") + (e?.stack || e?.message || String(e)));
  process.exit(1);
});
