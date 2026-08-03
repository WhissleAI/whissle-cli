# whissle — Voice Agents platform CLI

Run your whole Whissle workspace from the terminal or a script: **onboard**
(keys, teammates, contacts), **configure** agents, **connect integrations**,
**place calls and campaigns**, and **pull records** (calls, transcripts, usage,
analytics) for your own evaluation and logs.

It's the server-side companion to the browser embed SDK (`@whissle/agents`):
where the SDK *runs* one agent in a web page with a publishable `wpk_` key, this
CLI *manages* the workspace with a secret `wsk_` key. Plain Node ESM, no build
step, and every command takes `--json` for scripting.

## Install

```bash
git clone https://github.com/WhissleAI/whissle-cli
cd whissle-cli
npm install
npm link            # optional — puts `whissle` on your PATH
```

Requires Node 18+.

## Connect

Create a **workspace secret key** (`wsk_…`) in **Settings → API keys** on
whissle.ai, then:

```bash
whissle login          # paste the key (stored in ~/.whissle/config.json, 0600)
whissle whoami         # confirm the workspace + role
```

Or set `WHISSLE_API_KEY` in the environment (handy for CI). The CLI talks to the
production gateway by default (`aws-gateway-backend.whissle.ai/bot`); point it
elsewhere with `WHISSLE_BASE_URL` or `--base-url`.

> **Scopes matter.** Each command needs the matching scope on your key, and
> scopes are **fixed when the key is created**. Mint a key with the scopes you
> need — a `403 … missing required scope` names the one you're missing. See
> [Scopes](#scopes) below.

## Quickstart — onboard a workspace end to end

```bash
whissle keys create --name "ops key" --scopes agents:read,agents:write,calls:write,integrations:write
whissle team invite --email teammate@acme.com --role admin
whissle integrations catalog                       # browse the connector store
whissle integrations add --name Notion --url https://mcp.notion.com/mcp
whissle integrations connect <id> --oauth          # prints an authorize URL to open
whissle agents create --file examples/agents/dental-clinic.json
whissle customers import --file contacts.csv --agent <agent-id>
whissle calls campaign --agent <agent-id> --file contacts.csv --to-col phone --dry-run
whissle calls campaign --agent <agent-id> --file contacts.csv --to-col phone --yes
whissle analytics query --agent <agent-id> --days 7
whissle calls export --agent <agent-id> --format csv --out results.csv
```

See `examples/onboarding/README.md` for the annotated version.

## Commands

### Agents & running them
```bash
whissle agents list
whissle agents create --name "Acme Support" --prompt "You are Acme's support agent." --type customer_support
whissle agents create --file agent.json          # full package: agent + audio/config + knowledge
whissle agents get <id>
whissle agents update <id> --prompt "…"
whissle agents delete <id> [--force]
whissle chat <agent-id>                           # interactive text turn
whissle chat <agent-id> -m "what are your hours?" # one-shot
```

### Calls & outbound campaigns
```bash
whissle calls start --agent <id> --to +14155550123 \
  --var user_first_name=Karan --var need_appointment=true   # dynamic {{variables}}
whissle calls start --agent <id> --to +14155550123 --vars-file vars.json
whissle calls campaign --agent <id> --file contacts.csv --to-col to_number \
  --concurrency 3 --delay 1000 (--dry-run | --yes)          # one call per CSV row; each column → a variable
whissle calls list --agent <id> --limit 50
whissle calls get <call-id>                       # status, disposition, summary
whissle calls transcript <call-id>
whissle calls audio <call-id>                     # signed recording URL
whissle calls export --agent <id> --since 2026-07-01 --format jsonl|csv --out calls.jsonl
```
`campaign` places **real, billed** calls — it refuses without `--dry-run`
(preview) or `--yes`. See `examples/campaigns/`.

### Knowledge & custom tools
```bash
whissle kb list <agent-id>
whissle kb add <agent-id> --file handbook.pdf | --text "…" | --url https://acme.com/faq
whissle tools list
whissle tools create --file tool.json
whissle tools attach <tool-id> --agent <agent-id>
```

### Integrations (the MCP connector store)
```bash
whissle integrations catalog                      # 40+ one-click connectors, by category
whissle integrations list                         # your org's connected integrations
whissle integrations add --name Notion --url https://mcp.notion.com/mcp [--auth-mode oauth|bearer|apikey|none] [--token …]
whissle integrations connect <id> [--oauth]       # --oauth prints an authorize URL to open
whissle integrations attach <id> --agent <agent-id>   # let one agent use it
whissle integrations detach <id> --agent <agent-id>
whissle integrations remove <id>
```
Connected integrations are available to the `/chat` companion by default and can
be attached to individual agents.

### Connectors (stored org credentials, e.g. a FHIR/EHR server)
```bash
whissle connectors list --kind fhir
whissle connectors add --kind fhir --name "Epic Sandbox" --base-url https://fhir.example.org/r4 \
  --auth client_credentials --token-url https://auth.example.org/token --client-id abc --client-secret ***
whissle connectors remove <id> --force            # agents' fhir_* tools resolve these automatically
```

### Phone numbers
```bash
whissle numbers list                              # your numbers
whissle numbers available                         # claimable pool (no purchase)
whissle numbers search --country US --area 415
whissle numbers claim <number-id> | buy +14159675014 | connect +14159675014 --agent <id> | release <number-id>
```

### Customers (contacts — agent-scoped)
```bash
whissle customers list [--agent <id>] [--limit 50]
whissle customers get <id>
whissle customers create --name "Jane Doe" --phone +14155550123 --agent <agent-id> [--email …]
whissle customers import --file contacts.csv --agent <agent-id> [--map Col=target]
whissle customers update <id> --name … --phone … --email … --notes …
whissle customers delete <id>
```

### Appointments (booking config + calendars)
```bash
whissle appointments list [--agent <id>]          # booking settings
whissle appointments hours | set-hours --file hours.json [--agent <id>]
whissle appointments blocked | block --date 2026-08-10 [--reason r] | unblock <blocked-id>
whissle appointments calendar                     # connection status
```

### SMS (delivery log + consent)
```bash
whissle sms messages [--limit 50]
whissle sms opt-outs | consents
whissle sms opt-in +14155550123                   # re-enable a suppressed number
```
(Agents send SMS during calls; the CLI reads the log and manages consent.)

### Analytics
```bash
whissle analytics query [--agent <id>] [--metric …] [--group-by …] [--days 7] [--start …] [--end …]
whissle analytics options                         # available metrics/dimensions
whissle analytics charts                          # saved charts
```

### Campaigns (server-side, managed)
```bash
whissle campaigns list
whissle campaigns get <id>
whissle campaigns create --file campaign.json
whissle campaigns action <id> pause|resume|cancel
```
Distinct from `calls campaign` (a client-side CSV batch you drive from the CLI);
these are campaigns the platform manages.

### Meetings (notetaker)
```bash
whissle meetings list
whissle meetings get <id>
whissle meetings schedule --url https://meet.google.com/abc-defg-hij [--agent <id>] [--title "Standup"]
whissle meetings cancel <id>
```

### Company memory (the "Company Brain")
```bash
whissle memory list
whissle memory add --text "Our refund window is 30 days."
whissle memory confirm <id>                       # promote a proposed fact into the active Brain
whissle memory delete <id>
```

### Workspace — keys, team, billing, models
```bash
whissle keys list | create --name "ci" --scopes a,b,c [--type secret|publishable] | reveal <id> | delete <id>
whissle team list | invite --email person@co.com --role owner|admin|member | revoke <id>
whissle usage                                     # wallet balance + ledger
whissle models chat "Summarize this" --fast | tts "Hello" --out hi.mp3 | transcribe rec.wav --diarize
```

Add `--json` to any command for machine-readable output (pipe into `jq`, feed a
scoring script, etc.).

## Scopes

A `wsk_` key carries a fixed set of scopes chosen at creation. **Read** scopes
below are granted by default on a new key; **write** scopes (and money- or
privilege-sensitive ones) are opt-in — name them with `--scopes` when you
`whissle keys create`, or mint a fresh key. An old key can't gain a scope that
didn't exist when it was made.

| Area | Scopes |
|---|---|
| agents, embed, chat | `agents:read` / `agents:write` |
| calls, campaign (client batch) | `calls:read` / `calls:write` (start/campaign place calls) |
| kb | `kb:read` / `kb:write` |
| tools | `tools:read` / `tools:write` |
| connectors | `connectors:read` / `connectors:write` |
| numbers | `numbers:read` / `numbers:write` (buy spends credits) |
| **integrations** | `integrations:read` / `integrations:write` *(write = escalation)* |
| **customers** | `contacts:read` / `contacts:write` |
| **appointments** | `appointments:read` / `appointments:write` |
| **sms** | `sms:read` / `sms:write` |
| **analytics** | `analytics:read` |
| **campaigns** (server) | `campaigns:read` / `campaigns:write` |
| **team** (invitations) | `team:read` / `team:write` *(write = escalation)* |
| **meetings** | `meetings:read` / `meetings:write` |
| **memory** | `memory:read` / `memory:write` |
| models | `models:invoke` |
| usage | `billing:read` |

## Keys, at a glance

| Key | Where it runs | What it can do |
|---|---|---|
| `wsk_…` secret | server / CLI (this tool) | everything your scopes allow — manage the workspace, read all records |
| `wpk_…` publishable | the browser (`@whissle/agents`) | start a voice session with one agent, nothing else |

**Never put a `wsk_` key in a browser.**

## How it's built

Plain Node ESM, no build step. `src/api.mjs` is a **single, self-contained
gateway client** (bearer auth, JSON + multipart, error surfacing, org
resolution) with no CLI-specific imports — so every HTTP request lives in one
place, and the client can be lifted into a published `@whissle/sdk` later. Each
command group is `src/commands/<name>.mjs` exporting `run(sub, args, flags)`;
`bin/whissle.mjs` parses args and dispatches. See `CLAUDE.md` for the internals.
