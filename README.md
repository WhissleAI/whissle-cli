# whissle — Voice Agents platform CLI

Run your whole Whissle workspace from the terminal or a script: **onboard**
(keys, teammates, contacts), **configure** agents, **connect integrations**,
**place calls and campaigns**, **talk to your own assistant** (streamed, with its
tool calls and citations shown), and **pull records** (calls, transcripts, usage,
analytics) for your own evaluation and logs.

Plain Node ESM, no build step, and every command takes `--json` for scripting.

### Which package do I want?

We publish four clients and they are routinely confused for each other. They are
not alternatives — most integrations use two.

| Package | Where it runs | Key | What it's for |
|---|---|---|---|
| **[`@whissle/cli`](https://www.npmjs.com/package/@whissle/cli)** (this one) | your terminal, a CI job | `wsk_` workspace **secret** | the control plane: configure, run, and read back the workspace |
| **[`@whissle/agents`](https://www.npmjs.com/package/@whissle/agents)** | the **browser** | `wpk_` **publishable** | embed a live voice agent in a web page |
| **[`@whissle/sdk`](https://www.npmjs.com/package/@whissle/sdk)** | server-side **Node** | `wsk_` workspace **secret** | the same control plane from your own backend — never in client code |
| **[`whissle_sdk`](https://github.com/WhissleAI/whissle-python)** | server-side **Python** | `wsk_` workspace **secret** | the same, for Python jobs, evals and notebooks |

A typical embed uses two of them: `@whissle/sdk` (or this CLI) on your server to
mint each visitor a short-lived session token, and `@whissle/agents` in the page
to open the session with it. **A `wsk_` key must never reach a browser.**

## Install

```bash
npm i -g @whissle/cli
whissle version
```

`main` in this repo runs ahead of the published release, so if you want what this
README documents before the next publish, install from git:

```bash
npm i -g github:WhissleAI/whissle-cli
```

…or clone it, since there is nothing to build:

```bash
git clone https://github.com/WhissleAI/whissle-cli
cd whissle-cli
npm install
npm link            # optional — puts `whissle` on your PATH
```

Requires Node 18+. No build step — it's plain ESM, so what you clone is what runs.

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
whissle agents versions <id>                      # saved-config history (every save is snapshotted)
whissle agents rollback <id> <version-id>         # restore that version's content; deployment untouched
whissle agents clone <id>                         # duplicate as an undeployed draft ("<name> (copy)")
whissle agents types                              # agent-type keys for --type (customer_support, …)
whissle chat <agent-id>                           # interactive text turn
whissle chat <agent-id> -m "what are your hours?" # one-shot
whissle chat <agent-id> -m "and on Sundays?" --conversation <cid>   # continue that thread
whissle chat <agent-id> -m "…" --tools            # the per-tool timeline, not just names
whissle chat <agent-id> -m "…" --verbose          # quote the KB passages it cited
```

`chat` conversations are **persisted**, not scratch. Each run opens its own
session (stamped `source: "cli"`) and shows up in the studio under
**Agents → <your agent> → Sessions**, alongside that agent's voice calls — with
the transcript, the tools it called and, if the agent runs a flow, its flow
trace. The command prints the link when it starts. `/reset` starts a new
session; set `WHISSLE_STUDIO_URL` if you run a self-hosted studio.

**Multi-turn from a script.** Every turn prints (and `--json` returns) its
`conversation_id`; pass it back with `--conversation` and the next turn joins the
same thread, with the same memory:

```bash
cid=$(whissle chat "$A" -m "I'm calling about order 4471." --json | jq -r .conversation_id)
whissle chat "$A" -m "When does it ship?" --conversation "$cid" --json | jq -r .reply
```

**Citations and tool receipts.** A turn returns `evidence` (which document, which
page, and the passage) and `tool_events` (every tool, its arguments, and whether
it worked). Both are now rendered: `sources:` always, the full timeline under
`--tools`, the quoted passages under `--verbose`. A cited answer whose citations
you cannot see is indistinguishable from a guess.

`chat` needs only `chat:invoke`. It reads the agent record for a name and a
greeting when it can, and carries on without one when it cannot — a key scoped
`chat:invoke` and nothing else can chat.

### Your companion (`companion:invoke`)

Every other command here operates on the **workspace**. `whissle companion`
talks to the assistant that is **yours** — the one that knows your org, your
persona, your connected integrations and your own documents. It is not an agent
with a different id: the companion has no agent row, it is assembled per request,
and a `wsk_` key resolves to **one person**, so this reaches its creator's
companion and nobody else's.

```bash
whissle companion                                  # interactive, streamed
whissle companion -m "what's on my calendar today?"        # one-shot
whissle companion -m "…" --session <id>            # resume a thread
whissle companion -m "…" --no-stream               # one buffered JSON body
whissle companion -m "what is this?" --image screenshot.png
whissle companion info                             # the card: agent type, your session totals
whissle companion context                          # the org context it answers from
whissle companion refresh [--pc-id <live-session>] # re-read your connected integrations
whissle companion sessions                         # where the history lives
```

**Streaming is the default.** A `deep_research` turn is up to a minute of work;
buffered, that is a minute of blank screen. Streamed, the terminal narrates it as
it happens — the reply arrives token by token and each tool announces itself
("Searching the web…", "Reading 12 sources…") using the same event payloads a
voice session receives. `--no-stream` takes the buffered door.

**Threads.** `--session <id>` is the thread handle (the companion's own routes
key on it; the agent route uses `--conversation` instead — the two genuinely
differ). A run that mints one prints it to **stderr**, so stdout stays clean for
a pipe:

```bash
s=cli-$(uuidgen)
whissle companion -m "Track the ACME renewal for me." --session "$s"
whissle companion -m "What did I ask you to track?" --session "$s" --json | jq -r .reply
```

**Scripting a stream.** `--json` prints the terminal payload only — byte-identical
to what `--no-stream` returns, so a pipeline never has to strip narration out of
stdout. `--json --events` prints every frame as NDJSON instead, for a consumer
that wants the timeline:

```bash
whissle companion -m "…" --json --events | jq -c 'select(.event=="tool")'
```

#### Everyday tools

Nine small tools ship on the companion agent type, alongside the workspace ones.
They are declared on the type, so they are also what an **anonymous visitor**
gets when the agent embedded in your page is of type `companion` — no sign-in,
no workspace data. Ask the gateway rather than trusting this list:

```bash
whissle agents types --json | jq -r '.[] | select(.key=="companion") | .tools[]'
```

Three of them behave in ways worth knowing before you rely on them:

* **`get_crypto_price` and `get_stock_price` fail closed.** Without
  `COINGECKO_API_KEY` / `TWELVEDATA_API_KEY` on the deployment they *refuse* —
  they do not fall back to searching the web for a number and reading it out. A
  price the model found in a blog post is worse than no price. (The refusal is
  the tool's; nothing stops a model from calling `search_web` next, so the
  refusal text tells it not to.)
* **`get_weather` never guesses a location.** `location` is required, and with no
  location the tool comes back telling the model to *ask* — there is no IP
  geolocation and no default city.
* **`get_news` is the one tool with no required argument**, deliberately: "the
  news" has an honest default (the top stories), where a default *city* or a
  default *ticker* would be an invention.

The rest — `calculate`, `convert_units`, `get_time`, `convert_currency`,
`define_word` — need no configuration. `convert_currency` walks three keyless
rate sources and refuses if none answers rather than quoting a rate from memory.

#### External MCP tools are refused to anonymous callers

Tools reached through the [MCP connector store](#integrations-the-mcp-connector-store)
run against **somebody else's server**. An anonymous visitor — an embed widget, a
public chat — cannot call them. The refusal is by **provenance, not by name**:
a tool is allowed for an anonymous caller only if it is a built-in or one of your
own workspace's declared tools, so a tool whose origin cannot be established
fails closed, and a new remote tool is refused the day it appears rather than the
day someone remembers to add it to a list. A signed-in member, a live phone call
and a `wsk_` key are unaffected.

### Conversation flow (the in-call state machine)

An agent can carry an optional **flow**: a per-agent state machine that steers a
live voice/text call turn-by-turn (a state's prompt goal, which tools it may call,
per-state turn-taking) with guardrails — never a model selector. This is what
drives flow-based, guard-railed agents in evaluation harnesses.

```bash
whissle agents flow show <id> [--json]                    # states / transitions / settings (+ derived workflow & guardrails)
whissle agents flow generate <id> --goal "verify the policy number first"  # AI-draft a starter flow (not saved)
whissle agents flow set <id> --file flow.json             # author it (writes live)
whissle agents flow set <id> --file flow.json --draft     # stage it as a draft instead
whissle agents flow publish <id>                          # promote the staged draft → live
whissle agents flow discard <id>                          # throw the pending draft away
whissle agents flow trace <id> --conversation <cid>       # turn-by-turn step trace for one run
```

`flow.json` may be a bare flow object (`{version, start_state, states, …}`) or a
wrapper `{ "flow": { … } }`. A `flow` key inside an `agents create/update --file`
package is also applied, so a whole agent + flow ships in one file.

### Calls & outbound campaigns
```bash
whissle calls start --agent <id> --to +14155550123 \
  --var user_first_name=Karan --var need_appointment=true   # dynamic {{variables}}
whissle calls start --agent <id> --to +14155550123 --vars-file vars.json
whissle calls campaign --agent <id> --file contacts.csv --to-col to_number \
  --concurrency 3 --delay 1000 (--dry-run | --yes)          # one call per CSV row; each column → a variable
whissle calls list --agent <id> --limit 50 [--offset N] [--since 2026-07-01]
whissle calls get <call-id>                       # status, disposition, summary
whissle calls result <call-id>                    # the structured outcome envelope (ready, disposition, result)
whissle calls result <call-id> --wait             # poll until the session finalizes (or a terminal status)
whissle calls result <call-id> --wait --interval 5 --timeout 300 --json | jq .disposition
whissle calls transcript <call-id>
whissle calls audio <call-id>                     # recording URL (pre-signed on cloud storage)
whissle calls export --agent <id> --since 2026-07-01 --format jsonl|csv --out calls.jsonl
```
`campaign` places **real, billed** calls — it refuses without `--dry-run`
(preview) or `--yes`. See `examples/campaigns/`.

`result` is the partner **"get outcome"** op: after a call you (or your
integration — the n8n node mirrors it) poll `whissle calls result <id> --wait`
until `ready: true`, then read the disposition and the scorer's full structured
result. `--wait` exits non-zero on timeout, so it's safe to gate a script on.

`list` pages server-side. It asks the API for the paginating **summary** view, so
`--limit`, `--offset` and `--since` are applied by the database rather than after
the fact — on a workspace with 293 calls, `--limit 2 --json` is ~1 KB where it
used to be ~4.9 MB of full transcripts. `--json` is still a plain array, so
existing `jq '.[].id'` keeps working; the rows carry the scalar fields plus
`disposition` and `session_id`. Pass `--full` for the old every-field view
(transcripts included, and **no paging** — the server does not honour `limit`
there), or use `calls get` / `calls transcript` / `calls export` for bodies.

`audio` returns whatever the recording actually needs. On cloud storage (every
hosted workspace) that is a **pre-signed** URL you can hand straight to `curl`.
On a local-storage install the backend returns a relative API path instead; the
CLI absolutizes it against your base URL and says plainly that it still needs
your key, rather than implying a signature that isn't there. A call with no
recording exits `3`.

### Sessions (voice calls **and** text threads, one history)
```bash
whissle sessions list                              # newest first, both kinds, with a `kind` column
whissle sessions list --kind text --agent <id> --since 2026-08-01 --limit 50 --offset 50
whissle sessions list --agent companion            # YOUR OWN companion sessions, nobody else's
whissle sessions get <session-id>                  # summary + tool runs + transcript, either kind
whissle sessions trace <session-id>                # turn-by-turn observability (see below)
whissle sessions trace <session-id> --all --json | jq '.events.events[] | select(.data.failed_over)'
```
`calls` means *rows from the calls table*, and structurally cannot see a session
that never was a phone call — a CLI run, an embedded widget, an n8n step and a
partner integration all persist a **text** thread. `sessions` is the union of
both, on the same `calls:read` scope, so no key has to be re-issued.

`trace` is the observability view, and for a text session it is the **only**
place that shows:

* every tool run with its arguments, duration, outcome and the KB citations it
  raised — including a tool the model **invented**, which is a different fact
  from a tool that ran and failed;
* **which provider and model actually answered**, with a loud marker when the
  turn **failed over** from the primary vendor to the fallback — nothing else in
  the product surfaces that to a human, and the caller never sees it;
* per-turn latency, hop count and **token counts** (input / output / cached), and
  any action-integrity catch where the reply claimed something no tool did.

  Counts, not cost: the trace carries `input_tokens` / `output_tokens` /
  `cached_input_tokens` and no currency figure anywhere. For money, read
  `whissle usage`.

**Voice and text traces are not the same payload**, and the difference is worth
knowing before you build a dashboard on one. Both answer
`{call_id, flow, signals, events}`. A **text** trace is *derived* from the
persisted thread, so its `signals.turns[]` carry `provider`, `model`,
`failed_over`, `latency_ms`, `hops` and the token counts, and its voice-only
signal families are listed under `signals.unavailable` with a reason each —
rather than shown as zero, which would read as "we measured it and it was
silent". A **voice** trace is *recorded* live: `signals.turns[]` are acoustic
(emotion, intent, age/gender estimates, filler counts, WPM), and provider/model
appear only where the live recorder captured an `llm_call` event, in `events`.

```bash
whissle sessions trace <id> --json | jq '.signals.turns[] | {provider, model, failed_over}'
whissle sessions trace <id> --json | jq '.signals.unavailable | keys'   # text only
```

### Action inbox (human-in-the-loop approvals)
```bash
whissle actions list [--status pending|approved|rejected|auto_executed|all] [--agent <id>]
whissle actions approve <id>                      # runs the held action (send link, book slot, …)
whissle actions reject <id> [--reason "wrong number"]
whissle actions scheduled                         # upcoming auto follow-up calls, soonest first
whissle actions cancel-scheduled <id>
```
Sensitive post-call actions are **held as `pending`** until someone approves;
auto-fired ones show up read-only as `auto_executed`. `list` also shows the
pending count (the studio nav badge, from `/api/actions/count`).

### Compliance (Do-Not-Call, calling rules, evidence)
```bash
whissle compliance suppressions                   # the org's Do-Not-Call list
whissle compliance suppress +14155550123 --reason "asked to stop"
whissle compliance unsuppress +14155550123
whissle compliance settings                       # the rules the dial engine enforces
whissle compliance settings set --window-start 9 --window-end 20 --timezone America/New_York
whissle compliance settings set --require-consent true --disclosure-required true --retention-days 365
whissle compliance settings set --file settings.json
whissle compliance events --days 30               # what the rules DID (blocked dials, disclosures)
```
The DNC list is also written automatically by the `stop_calling` post-call tool,
and enforcement happens **pre-dial** on the backend — this surface is the audit
trail and the controls.

### Knowledge & custom tools
```bash
whissle kb list <agent-id>
whissle kb add <agent-id> --file handbook.pdf | --text "…" | --url https://acme.com/faq
whissle kb update <agent-id> <doc-id> --text "…"   # replace a document in place (reindexed)
whissle kb remove <agent-id> <doc-id> --force      # also disarms any lookup tool built from it
whissle tools list
whissle tools create --file tool.json
whissle tools update <tool-id> --file tool.json   # edit description / parameters / binding / enabled
whissle tools delete <tool-id>
whissle tools attach <tool-id> --agent <agent-id>
```

#### Your own documents (`whissle kb me`)

An agent's knowledge base is org property: it grounds what that agent says to
strangers. `whissle kb me` is a different thing that happens to share a scope —
**your** private library. What you upload belongs to you, is readable only by
you, and is never folded into any agent's prompt. Your companion reads it on
your behalf and cites it back.

```bash
whissle kb me list [--limit N] [--offset N]
whissle kb me add notes.pdf                      # drop a file on your assistant
whissle kb me add notes.pdf --session <chat-session-id>   # …and tell that thread it arrived
whissle kb me get <doc-id> [--out file]          # the original bytes back
whissle kb me remove <doc-id> --force
```

`add` prints the ingest **manifest**, not a green tick: how many characters and
chunks landed, whether it replaced an earlier copy, and — the line that matters —
whether it is `searchable`. A file we cannot read comes back as an error with the
reason rather than as an empty document that looks ingested. There is no `--user`
flag, because no route under `/api/me/kb` takes a user id; the only user in scope
is the authenticated one, and that is the whole tenancy control.

Then ask about it:

```bash
whissle kb me add handbook.pdf
whissle companion -m "What does my handbook say about carry-over leave?" --verbose
#   sources:
#   [1] handbook.pdf  p. 12 · your documents · score 0.71
#       /api/me/kb/…/file
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
whissle connectors test <id>                      # health-check the stored credential (auth/URL) before a call
whissle connectors update <id> --file connector.json   # edit name / config / is_active (cookie-auth today)
whissle connectors remove <id> --force            # agents' fhir_* tools resolve these automatically
```

### Web embed (run an agent inside your own product)
```bash
whissle embed enable <agent-id> --origin https://yoursite.com [--text]
whissle embed show <agent-id>                     # embed key + paste-able iframe snippet
whissle embed token <agent-id>                    # mint one visitor's session token
whissle embed token <agent-id> --avatar F1-HR     # + a browser-rendered avatar token
```

Two ways to embed. The **iframe** (`embed show`) is no-code: paste the snippet
and you're done. `embed token` is the other one — the primitive for putting an
agent inside a UI you built yourself, where your own backend already knows who
the visitor is:

```
your page  ──"start"──▶  YOUR backend  ──whissle embed token──▶  Whissle
                              │
                              ╰── short-lived token ──▶  your page
                                                            │
                                          POST /api/embed/offer?token=…  (voice, SDP)
                                          POST /api/embed/chat/turn      (text)
```

Minting with your **secret** (`wsk_`) key makes the session *server-trusted*: the
token carries no origin, so it works from any page and survives a media
reconnect — you never allowlist an origin on the Whissle side, because your key
already is the trust boundary. Your key stays on your server; the browser only
ever holds a token that expires in 15 minutes. (Minting with a publishable
`wpk_` key instead gives you an origin-bound, single-use token — that's what the
`@whissle/agents` SDK does when it runs the mint from the browser.)

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
whissle models chat "Summarize this" --fast
whissle models tts "Hello" --out hi.mp3                       # English (default)
whissle models tts "नमस्ते, कैसे हैं आप?" --language hi --out namaste.mp3   # speaks Hindi
whissle models voices                             # voice ids for --voice (grouped by engine)
```
`models tts` takes `--language en|hi|te|hinglish|tenglish` (omit it and the platform
auto-detects from the script); the voice/engine is chosen for you, never exposed.

Add `--json` to any command for machine-readable output (pipe into `jq`, feed a
scoring script, etc.).

### Transcription (pre-recorded calls & meetings)

Turn a recorded call or meeting into text — you pick the **language**, the
platform picks the engine (the model/provider is pre-configured and never
exposed). Speaker turns come from Whissle's own diarization.

```bash
whissle models transcribe call.wav                       # defaults to English
whissle models transcribe call.mp3 --language en         # English
whissle models transcribe call.mp3 --language hi         # Hindi (Devanagari)
whissle models transcribe call.mp3 --language te         # Telugu
whissle models transcribe call.mp3 --language hinglish   # Hindi–English code-mixed
whissle models transcribe call.mp3 --language tenglish   # Telugu–English code-mixed
whissle models transcribe call.wav --language en --diarize --json   # speaker-tagged segments
```

| flag | values | default |
|---|---|---|
| `--language` | `en` · `hi` · `te` · `hinglish` · `tenglish` | `en` |
| `--diarize` | (bool) tag speaker turns | off |
| `--json` | full `{text, segments[], duration_seconds, cost_usd}` | table |

Common audio containers work (wav, mp3, m4a, flac). Billed per second of audio
against your workspace wallet (`whissle usage`).

## Scopes

A `wsk_` key carries a fixed set of scopes chosen at creation. **Read** scopes
below are granted by default on a new key; **write** scopes (and money- or
privilege-sensitive ones) are opt-in — name them with `--scopes` when you
`whissle keys create`, or mint a fresh key. An old key can't gain a scope that
didn't exist when it was made.

| Area | Scopes |
|---|---|
| agents, embed | `agents:read` / `agents:write` (versions/rollback/clone too) |
| **chat** (agent text turns) | `chat:invoke` — on its own; `agents:read` only adds the name/greeting |
| **companion** (your assistant) | `companion:invoke` — resolves to the key's creator, nobody else |
| calls, campaign (client batch) | `calls:read` / `calls:write` (start/campaign place calls; `result` is read) |
| **sessions** (voice + text history, traces) | `calls:read` |
| **actions** (inbox) | `actions:read` / `actions:write` (approve/reject/cancel) |
| **compliance** | `compliance:read` / `compliance:write` *(write = owner/admin)* |
| kb (agent) and **kb me** (your own) | `kb:read` / `kb:write` |
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

## Scripting contract

Three things are stable enough to build a script on: `--json`, per-group
`--help`, and the exit codes.

### `--json` everywhere

Every command takes `--json` and prints the raw API payload — no colour, no
tables, no truncation — so you can pipe it straight into `jq`:

```bash
whissle sessions list --kind text --json | jq -r '.items[].id'   # NOT .sessions[]
whissle calls result <id> --wait --json | jq '.result.disposition'
whissle sessions trace <id> --all --json | jq '.events.events[] | select(.data.failed_over)'
whissle companion -m "…" --json | jq -r .reply
whissle kb me list --json | jq -r '.documents[].title'
```

Without `--json` the output is formatted for a human and its layout is *not* a
contract — don't parse it.

**A write that answers `204` still answers in JSON.** Half the mutating routes on
this API return no body — every `delete`, and the `attach`/`detach` pairs. Those
commands print a minimal acknowledgement (`{"deleted": "<id>"}`,
`{"attached": "<id>", "agent_id": "<id>"}`) rather than a green tick, so a
pipeline never receives an empty stream where JSON was promised:

```bash
whissle tools delete <tool-id> --json          # → {"deleted": "<tool-id>"}
whissle integrations detach <id> --agent <a> --json
```

**Where the payload is not literally one server response**, the command says so
in its shape rather than quietly reshaping the server's: `whissle usage --json`
merges the wallet with its ledger (and adds `ledger_error` if the ledger could
not be read); `whissle calls audio --json` returns the server body **verbatim**
plus a `resolved_url` field, rather than overwriting `url`; `whissle calls
campaign --json` returns one row per CSV line, each carrying the server's own
`result` payload.

**Streamed commands keep the contract.** `whissle companion` streams by default,
but `--json` still prints exactly one payload — the same body `--no-stream`
returns — on stdout, with the narration suppressed and the thread id sent to
**stderr**. Add `--events` when you want the frames themselves, as NDJSON. Errors
raised *before* a stream opens (bad key, missing scope, no credit) are ordinary
HTTP and map onto the same exit codes as every other command.

### Per-group `--help`

`whissle help` lists the groups; `whissle <group> --help` documents one group's
subcommands and flags without hitting the network:

```bash
whissle sessions --help
whissle embed --help
whissle calls --help
```

### Exit codes

Every command exits with a code a script can branch on, not a blanket `1`:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | generic failure (unmapped 4xx, a 5xx, a network error, a usage mistake) |
| `2` | auth — no key, invalid/revoked key, or the key lacks the scope (401 / 403) |
| `3` | not found — no such record, or not visible to this key (404) |
| `4` | out of credit (402) — retrying will not help; top up in Settings → Billing |

`whissle whoami` is held to this too: a rejected key exits `2` instead of
printing a cached workspace and claiming success.

**Batch commands report the batch.** `whissle calls campaign` and `whissle calls
export` used to exit `0` whatever happened to the individual rows — so 500 calls
refused for credit printed `✓ Campaign done — 0/500 placed` and a cron job never
alerted. They now exit non-zero whenever any row failed, with the code every
failure agrees on (all `402` → `4`) or `1` when they disagree. `calls export`
additionally **leaves out** any call it could not fetch in full and says so on
stderr, instead of writing a row with an empty transcript that is
indistinguishable from a call nobody spoke on.

They're chosen so a CI job can branch without parsing text — `2` means fix the
key, `4` means top up, and neither is worth a retry:

```bash
whissle sessions get "$ID" --json > session.json
case $? in
  0) echo "ok" ;;
  2) echo "::error::bad or unscoped key"; exit 1 ;;
  3) echo "no such session"; exit 0 ;;
  4) echo "::error::out of credit"; exit 1 ;;
  *) echo "::error::transient — retrying"; exit 75 ;;
esac
```

## Keys, at a glance

| Key | Where it runs | What it can do |
|---|---|---|
| `wsk_…` secret | server / CLI (this tool), [`@whissle/sdk`](https://www.npmjs.com/package/@whissle/sdk), [`whissle_sdk`](https://github.com/WhissleAI/whissle-python) | everything your scopes allow — manage the workspace, read all records |
| `wpk_…` publishable | the browser ([`@whissle/agents`](https://www.npmjs.com/package/@whissle/agents)) | start a voice session with one agent, nothing else |

**Never put a `wsk_` key in a browser.**

## How it's built

Plain Node ESM, no build step. `src/api.mjs` is a **single, self-contained
gateway client** (bearer auth, JSON + multipart, error surfacing, org
resolution) with no CLI-specific imports — so every HTTP request lives in one
place, and it mirrors the standalone server-side TypeScript client
([`whissle-sdk`](https://github.com/WhissleAI/whissle-sdk), npm name
`@whissle/sdk`). Each
command group is `src/commands/<name>.mjs` exporting `run(sub, args, flags)`;
`bin/whissle.mjs` parses args and dispatches. See `CLAUDE.md` for the internals.
