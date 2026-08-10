#!/usr/bin/env node
// Whissle Voice Agents CLI — entry point.
//
// Grammar:  whissle <group> [subcommand] [positionals…] [--flags]
// Global flags: --json (machine output), --base-url <url>, --key <wsk_…>
import { pathToFileURL } from "node:url";
import { ApiError } from "../src/api.mjs";
import { err, out, brand, bold, dim } from "../src/ui.mjs";

const GROUPS = {
  agents: () => import("../src/commands/agents.mjs"),
  chat: () => import("../src/commands/chat.mjs"),
  calls: () => import("../src/commands/calls.mjs"),
  actions: () => import("../src/commands/actions.mjs"),
  compliance: () => import("../src/commands/compliance.mjs"),
  kb: () => import("../src/commands/kb.mjs"),
  tools: () => import("../src/commands/tools.mjs"),
  connectors: () => import("../src/commands/connectors.mjs"),
  numbers: () => import("../src/commands/numbers.mjs"),
  integrations: () => import("../src/commands/integrations.mjs"),
  embed: () => import("../src/commands/embed.mjs"),
  models: () => import("../src/commands/models.mjs"),
  keys: () => import("../src/commands/keys.mjs"),
  team: () => import("../src/commands/team.mjs"),
  customers: () => import("../src/commands/customers.mjs"),
  appointments: () => import("../src/commands/appointments.mjs"),
  sms: () => import("../src/commands/sms.mjs"),
  analytics: () => import("../src/commands/analytics.mjs"),
  campaigns: () => import("../src/commands/campaigns.mjs"),
  meetings: () => import("../src/commands/meetings.mjs"),
  memory: () => import("../src/commands/memory.mjs"),
  usage: () => import("../src/commands/usage.mjs"),
  config: () => import("../src/commands/config.mjs"),
};
// config.mjs also serves these top-level verbs (sub = the verb itself):
const CONFIG_VERBS = new Set(["login", "logout", "whoami"]);

/** Split tokens into { positionals, flags }. Flags: --k v, --bool, -m v. */
export function parse(tokens) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      const val = next === undefined || next.startsWith("-") ? true : (i++, next);
      // Repeated flags (e.g. --var k=v --var k2=v2) collect into an array; a single
      // occurrence stays scalar, so existing scalar-flag readers are unaffected.
      if (key in flags) flags[key] = [].concat(flags[key], val);
      else flags[key] = val;
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
  whissle agents versions <id>        saved-config history (every save is snapshotted)
  whissle agents rollback <id> <version-id>   restore content; deployment untouched
  whissle agents clone <id>           duplicate as an undeployed draft
  whissle agents types                agent-type keys for --type (customer_support, …)

${bold("Conversation flow")}  ${dim("— the in-call state machine (flow-based, guard-railed agents)")}
  whissle agents flow show <id> [--json]         states / transitions / settings (+ derived views)
  whissle agents flow set <id> --file flow.json [--draft]   author the flow (--draft stages it)
  whissle agents flow generate <id> --goal "…"   AI-draft a starter flow (not saved)
  whissle agents flow trace <id> --conversation <cid>   turn-by-turn step trace for one run
  whissle agents flow publish <id>               promote the staged draft → live
  whissle agents flow discard <id>               throw the pending draft away

${bold("Run an agent")}
  whissle chat <agent-id>             interactive text conversation
  whissle chat <agent-id> -m "hi"     one-shot (scriptable)
  ${dim("(browser voice embed → the @whissle/agents JS SDK + a publishable wpk_ key)")}

${bold("Records & evaluation")}  ${dim("(needs calls:read)")}
  whissle calls start --agent <id> --to <+1…> [--from <+1…>]
                      [--var key=value ...] [--vars-file vars.json]   one outbound call
  whissle calls campaign --agent <id> --file contacts.csv [--to-col to_number]
                      [--concurrency 3] [--delay 1000] (--dry-run | --yes)   batch calls, one per CSV row
  whissle calls list [--agent <id>] [--status s] [--limit N]
  whissle calls get <id>
  whissle calls result <id> [--wait] [--interval 5] [--timeout 300]   outcome envelope
                      (disposition + structured result; --wait polls until finalized)
  whissle calls transcript <id>
  whissle calls audio <id>            signed recording URL
  whissle calls export [--agent <id>] [--since 2026-07-01] [--format jsonl|csv] [--out f]

${bold("Knowledge & tools")}
  whissle kb list <agent-id>
  whissle kb add <agent-id> [--text … | --file f.pdf | --url https://…]
  whissle kb update <agent-id> <doc-id> [--title …] [--text …]   re-sync in place (reindexes)
  whissle kb remove <agent-id> <doc-id> --force
  whissle tools list
  whissle tools create --file tool.json
  whissle tools update <tool-id> --file tool.json
  whissle tools delete <tool-id>
  whissle tools attach <tool-id> --agent <agent-id>

${bold("Connectors")}  ${dim("(needs connectors:read/write)")}  ${dim("— stored org credentials, e.g. FHIR/EHR")}
  whissle connectors list [--kind fhir]
  whissle connectors add --kind fhir --name "Epic Sandbox" --base-url https://fhir…/r4 \\
                         --auth client_credentials --token-url … --client-id … --client-secret …
  whissle connectors test <id>                       health-check a stored connector
  whissle connectors update <id> --file connector.json   ${dim("(cookie-auth today)")}
  whissle connectors remove <id> [--force]

${bold("Integrations")}  ${dim("— the MCP connector app store; enable external tools on agents")}
  whissle integrations catalog                       curated providers
  whissle integrations list
  whissle integrations add --name "GitHub" --url https://… [--auth-mode oauth|bearer|apikey|none] [--token …]
  whissle integrations connect <id> [--oauth]        test / authenticate (oauth prints an authorize URL)
  whissle integrations attach <id> --agent <agent-id>   |   detach <id> --agent <agent-id>
  whissle integrations remove <id>

${bold("Onboarding")}  ${dim("— stand up a workspace: keys, teammates, contacts")}
  whissle keys list
  whissle keys create --name "Prod" [--scopes agents:read,calls:read] [--publishable]   ${dim("(secret shown once)")}
  whissle keys reveal <id> | delete <id>
  whissle team list
  whissle team invite --email person@co.com [--role owner|admin|member]
  whissle team revoke <invitation-id>
  whissle customers list [--limit N] [--agent <id>]
  whissle customers create --name N --phone <+1…> --agent <agent-id> [--email e]
  whissle customers import --file contacts.csv --agent <agent-id> [--on-duplicate skip|update]
  whissle customers get <id> | update <id> --<field> v | delete <id>

${bold("Appointments")}  ${dim("— per-agent booking config (--agent optional)")}
  whissle appointments list | calendar
  whissle appointments hours | set-hours --file hours.json
  whissle appointments blocked | block --date YYYY-MM-DD | unblock <id>

${bold("Action inbox")}  ${dim("(needs actions:read/write)")}  ${dim("— approve/reject held post-call actions")}
  whissle actions list [--status pending|all] [--agent <id>]
  whissle actions approve <id> | reject <id> [--reason r]
  whissle actions scheduled           upcoming auto follow-up calls
  whissle actions cancel-scheduled <id>

${bold("Compliance")}  ${dim("(needs compliance:read/write)")}  ${dim("— Do-Not-Call list, calling rules, evidence")}
  whissle compliance suppressions
  whissle compliance suppress <+1…> [--reason r] | unsuppress <+1…>
  whissle compliance settings | settings set [--window-start 9 --window-end 20 --timezone …]
  whissle compliance events [--days 30]

${bold("SMS")}  ${dim("— delivery log + consent (no send; agents send SMS)")}
  whissle sms messages [--limit N] | opt-outs | consents
  whissle sms opt-in <+1…>            re-enable a suppressed number

${bold("Analytics")}  ${dim("(needs analytics:read)")}
  whissle analytics query [--metric count] [--group-by day] [--since D --until D] [--agent <id>]
  whissle analytics options | charts

${bold("Campaigns")}  ${dim("— SERVER-SIDE managed dialing (vs. `calls campaign` = client-side CSV batching)")}
  whissle campaigns list | get <id>
  whissle campaigns create --file campaign.json
  whissle campaigns action <id> <pause|resume|cancel>

${bold("Meetings")}  ${dim("— notetaker: send an agent into a Google Meet")}
  whissle meetings list | get <id>
  whissle meetings schedule --url https://meet.google.com/… [--agent <id>] [--title T]
  whissle meetings cancel <id>

${bold("Company Brain")}  ${dim("— org facts that ground every agent")}
  whissle memory list [--status active|proposed]
  whissle memory add --text "We close on federal holidays."
  whissle memory confirm <id> | delete <id>

${bold("Channels — one agent, everywhere")}
  ${dim("Web embed")}  ${dim("(agents:write)")}
  whissle embed enable <agent-id> --origin https://yoursite.com   voice widget on a site
  whissle embed show <agent-id>          embed key + paste-able snippet
  whissle embed token <agent-id> [--avatar <code>]   mint a visitor session token
  ${dim("(token = the per-visitor session your OWN backend mints; the key stays server-side)")}
  ${dim("Phone")}  ${dim("(numbers:read / numbers:write)")}
  whissle numbers search [--country US] [--area 415]
  whissle numbers buy <+1…>              buy a number (deducts credits)
  whissle numbers connect <+1…> --agent <agent-id>   route inbound to that agent
  whissle numbers list | release <number-id>

${bold("À-la-carte models")}  ${dim("(needs models:invoke)")}
  whissle models chat "prompt" [--system …] [--fast]
  whissle models tts "text" [--voice …] --out speech.mp3
  whissle models transcribe audio.wav [--language xx] [--diarize]
  whissle models voices               voice ids for --voice (grouped by engine)

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

// Only run the CLI when invoked directly — importing this module (e.g. from the
// test suite, to exercise `parse`) must not kick off `main()`.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    if (e instanceof ApiError) err(brand("✗ ") + e.message);
    else err(brand("✗ ") + (e?.stack || e?.message || String(e)));
    process.exit(1);
  });
}
