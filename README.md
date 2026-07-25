# whissle — Voice Agents platform CLI

Configure Whissle voice agents, run them, and pull your calls, transcripts and
usage — from the terminal or a script. It's the server-side companion to the
browser embed SDK (`@whissle/agents`): where the SDK *runs* an agent in a web
page with a publishable key, this CLI *manages* your workspace and gives you
programmatic access to your records for your own evaluation and logs.

## Install

```bash
cd whissle_bash_cli
npm install
npm link            # optional — puts `whissle` on your PATH
```

Requires Node 18+.

## Connect

Create a **workspace secret key** (`wsk_…`) in **Settings → API keys** on
platform.whissle.ai, then:

```bash
whissle login          # paste the key (stored in ~/.whissle/config.json, 0600)
whissle whoami         # confirm the workspace
```

Or set `WHISSLE_API_KEY` in the environment (handy for CI). Point at a different
gateway with `WHISSLE_BASE_URL` or `--base-url`.

## What you can do

```bash
# Configure agents
whissle agents list
whissle agents create --name "Acme Support" --prompt "You are Acme's support agent." --type customer_support
whissle agents create --file agent.json
whissle agents update <id> --prompt "…"
whissle agents get <id>

# Run one (text; voice embed is the JS SDK)
whissle chat <agent-id>                 # interactive
whissle chat <agent-id> -m "what are your hours?"   # one-shot

# Records & evaluation  (key needs calls:read)
whissle calls list --agent <id> --limit 50
whissle calls transcript <call-id>
whissle calls audio <call-id>           # signed recording URL
whissle calls export --agent <id> --since 2026-07-01 --format jsonl --out calls.jsonl

# Knowledge & custom tools
whissle kb add <agent-id> --file handbook.pdf
whissle kb add <agent-id> --url https://acme.com/faq
whissle tools create --file tool.json
whissle tools attach <tool-id> --agent <agent-id>

# À-la-carte models  (key needs models:invoke)
whissle models chat "Summarize this call" --fast
whissle models tts "Hello from Whissle" --out hello.mp3
whissle models transcribe recording.wav --diarize

# Billing
whissle usage
```

Add `--json` to any command for machine-readable output (pipe into `jq`, feed a
scoring script, etc.). `whissle export … --out` is the fastest way to get a
dataset of calls + transcripts for your own eval harness.

## Scopes & current limits

Each command needs the matching scope on your key (set them when you create the
key). A `403 … missing required scope` tells you exactly which one:

| Command | Scope |
|---|---|
| `agents …` | `agents:read` / `agents:write` |
| `calls …`, `chat` | `calls:read` (chat also uses `agents:write`) |
| `kb …` | `kb:read` / `kb:write` |
| `models …` | `models:invoke` |
| `usage` | `billing:read` |

**Known limit:** `whissle tools …` needs the custom-tools API to accept API keys —
today that management endpoint is dashboard-only, so tool CRUD from the CLI is
pending a small backend change. Everything else works with a secret key.

## Keys, at a glance

| Key | Where it runs | What it can do |
|---|---|---|
| `wsk_…` secret | server / CLI (this tool) | everything your scopes allow — configure agents, read all records |
| `wpk_…` publishable | the browser (`@whissle/agents`) | start a voice session with one agent, nothing else |

Never put a `wsk_` key in a browser.

## How it's built

Plain Node ESM, no build step. `src/api.mjs` is a self-contained gateway client
(bearer auth, JSON + multipart, error surfacing, org resolution) — it has no
CLI-specific imports so it can be lifted into a published `@whissle/sdk` package
later; the CLI is just its first consumer. Commands live in `src/commands/*.mjs`.
