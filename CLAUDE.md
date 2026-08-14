# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

`whissle` is the command-line interface for the **Whissle Voice Agents platform**
(the gateway at `aws-gateway-backend.whissle.ai/bot`). It lets a user **configure**
agents, **run** them (text chat), and **pull records** (calls, transcripts,
recordings, usage) for their own evaluation and logs. Node.js ESM, no build step.

Four clients share this gateway, and they are routinely confused for each other:
`@whissle/cli` (this repo — the terminal control plane, `wsk_`),
`@whissle/agents` (browser voice embed, publishable `wpk_`, `SDKs/agents_js_sdk`),
`@whissle/sdk` (server-side Node, `wsk_`, `SDKs/whissle-sdk`) and `whissle_sdk`
(server-side Python, `wsk_`, `SDKs/whissle-python`). The three `wsk_` clients keep
DELIBERATELY PARALLEL path maps — `src/endpoints.mjs` here, `src/endpoints.ts`
there, `whissle_sdk/endpoints.py` there — because two divergent maps is how one of
them silently rots. Change a route in all three or in none.

> Note: this project used to be a terminal *coding assistant* (SSE REPL against
> `api.whissle.ai`, local read/write/bash tools). That was fully removed and
> replaced — do not resurrect it.

## Commands

```bash
npm install
node bin/whissle.mjs            # or `whissle` after `npm link`
node bin/whissle.mjs help
npm test                        # node --test "test/*.test.mjs" (pure-function units + source-level
                                # contract checks; no network — the only subprocesses run --help offline)
```

## Architecture

```
bin/whissle.mjs        entry — arg/flag parse, group dispatch, help, error handling
src/config.mjs         ~/.whissle/config.json (0600) + env overrides (WHISSLE_API_KEY, WHISSLE_BASE_URL)
src/api.mjs            gateway REST HTTP CLIENT — bearer auth, JSON/multipart/raw, error surfacing, resolveOrgId().
                       Self-contained (only imports endpoints.mjs) so it can become @whissle/sdk.
src/endpoints.mjs      SINGLE SOURCE OF TRUTH for every backend PATH the CLI calls, grouped by domain and
                       exported as `EP`. Pure path module — no imports, no side effects. Static paths are
                       strings; parameterized/org-scoped paths are builder fns (org id is the first arg;
                       the command still calls resolveOrgId() and passes it in). Move a route → change it HERE.
src/ui.mjs             chalk table/kv/json/markdown(marked-terminal)/spinner. Brand accent #e5484d.
src/commands/
  config.mjs           login / logout / whoami / config
  agents.mjs           list / get / create / update / delete / versions / rollback / clone   (agents:read/write)
                       create --file agent.json = full package: create + PATCH audio/config + ingest knowledge.
                       CREATE_FIELDS vs PATCH_FIELDS decide the two-step apply — keep examples/README.md in sync.
  chat.mjs             interactive + one-shot text turn → POST /api/agents/{id}/chat/turn
                       Sends source:"cli" + a per-run session_id so each run is its own
                       SESSION in the studio's history (not one shared per-key thread),
                       and prints the studio link. turnBody/sessionsUrl are exported for tests.
                       BOTH handles ride on EVERY turn. The server looks up conversation_id
                       first and session_id is then never read; it is read only on the branch
                       that OPENS a thread — which is where a stale/foreign --conversation
                       lands, because the server declines an id it cannot resolve rather than
                       failing the turn. Withholding the session key there dropped that turn
                       into `key:<api-key-id>`, the per-key catch-all thread session_id exists
                       to prevent. (routes/agents.py ChatTurnBody + session_history.thread_key.)
  calls.mjs            start / campaign / list / get / result / transcript / audio / export
                       start = one outbound call; campaign = one call per CSV row (each column ->
                       a dynamic {{variable}}, --to-col picks the callee, gated by --dry-run/--yes).
                       start/campaign take --var k=v / --vars-file. (calls:read records; calls:write to place)
                       result = the partner outcome envelope (GET /api/calls/{id}/result); --wait polls until
                       ready:true or a terminal status (isTerminal() in calls.mjs, unit-tested in test/).
  sessions.mjs         list / get / trace                        (calls:read; /api/sessions — the UNION of `calls`
                       and text `conversations`, each item tagged kind=voice|text. `calls` cannot see a CLI /
                       widget / n8n thread at all. `--agent companion` returns the CALLER'S OWN companion
                       sessions only. trace = per-turn observability: tool runs with args/duration/citations,
                       WHICH PROVIDER ANSWERED + a marker when it failed over (surfaced nowhere else in the
                       product), token COUNTS (input/output/cached — there is no currency figure anywhere
                       in a trace), latency, invented tools and action-integrity catches. TEXT traces are
                       DERIVED from the persisted thread, so signals.turns[] carry provider/model/
                       failed_over/latency_ms/hops + counts, and voice-only families are listed under
                       signals.unavailable with a reason each. VOICE traces delegate to
                       /api/calls/{id}/trace and are RECORDED: signals.turns[] are acoustic (emotion,
                       intent, age/gender, fillers, wpm) and provider/model appear only as llm_call
                       entries in `events`, where the live recorder caught them. Do not assume one shape.
                       Pure shapers (summarize/groupByTurn/partitionEvents/*Lines) are exported + unit-tested.
  actions.mjs          list / approve / reject / scheduled / cancel-scheduled   (actions:read/write; /api/actions —
                       NOT org-prefixed. The human-approval queue for held post-call actions + scheduled follow-ups.)
  compliance.mjs       suppressions / suppress / unsuppress / settings [set] / events   (compliance:read/write;
                       org-scoped: /api/orgs/{org}/compliance — Do-Not-Call list, dial rules, evidence trail)
  kb.mjs               list / add (text|file|url) / update / remove   (kb:read/write)
                       update/remove act on ONE document (EP.agents.kb.doc). They're what makes a
                       knowledge sync idempotent — without them a re-push only ever ADDS, so an
                       agent ends up holding every past revision and retrieval quotes the oldest.
  tools.mjs            list / create / attach                   (org-scoped: /api/orgs/{org}/tools)
  connectors.mjs       list / add / remove                      (connectors:read/write; org-scoped: /api/orgs/{org}/credentials)
                       stored org credentials, e.g. a FHIR/EHR server — an agent's fhir_* tools resolve them.
  embed.mjs            show / enable / disable                  (agents:read/write; /api/agents/{id}/embed) — voice widget on a site
                       token = the RUNTIME half: mint a per-visitor session token (EP.embed.*, the
                       PUBLIC /api/embed/* routes). A wsk_ mint is SERVER-TRUSTED — the token carries
                       no origin, so a partner backend hands it to any browser without allowlisting
                       an origin here. --avatar chains the browser-direct Simli mint.
  numbers.mjs          list / available / search / buy / claim / connect / release  (numbers:read/write; /api/orgs/{org}/twilio)
  integrations.mjs     catalog / list / add / connect / attach / detach / remove   (MCP connector store; org-scoped: /api/orgs/{org}/integrations) †
  models.mjs           chat / tts / transcribe                  (models:invoke)
  keys.mjs             list / create / reveal / delete          (org-scoped: /api/orgs/{org}/api-keys) — secret shown once on create †
  team.mjs             list / invite / revoke                   (invitations; org-scoped: /api/orgs/{org}/invitations) †
  customers.mjs        list / get / create / import / update / delete   (contacts:read/write; /api/customers — NOT org-prefixed; contacts are agent-scoped so create/import need --agent)
  appointments.mjs     list / hours / set-hours / blocked / block / unblock / calendar   (org-scoped: /api/orgs/{org}/appointments; --agent optional) †
  sms.mjs              messages / opt-outs / consents / opt-in  (org-scoped: /api/orgs/{org}/sms — read + consent mgmt; agents send SMS, not the CLI) †
  analytics.mjs        query / options / charts                 (analytics:read; org-scoped: /api/orgs/{org}/analytics)
  campaigns.mjs        list / get / create / action             (campaigns:read/write; /api/campaigns — SERVER-SIDE managed, vs. `calls campaign` = client-side CSV batching)
  meetings.mjs         list / get / schedule / cancel           (notetaker; /api/meetings) †
  memory.mjs           list / add / confirm / delete            (Company Brain; org-scoped: /api/orgs/{org}/memory) †
  usage.mjs            wallet balance + ledger                  (/api/orgs/{org}/wallet)

  † These backend routes are cookie-auth today; a parallel backend PR makes them
    `wsk_`-key-authable. The CLI commands are correct and light up once that lands.

examples/
  agents/              ready-to-use agent packages for `agents create --file` (see examples/README.md — field reference)
  tools/               a sample custom-tool spec for `tools create --file`
  onboarding/          end-to-end flow: key → teammate → integration → customers → agent → campaign → analytics
  tests/               agentic-harness.mjs — multi-turn smoke test: create → converse → flag → delete (see examples/tests/README.md)
```

The `connectors:read/write` scope is newer than the others; a key minted before it
existed cannot be granted it and is refused — mint a fresh key to manage connectors.

## Key patterns

- **ESM only** (`.mjs`), Node 18+ built-ins (global `fetch`, `FormData`, `Blob`).
- **Auth**: a `wsk_` secret key as `Authorization: Bearer`. Most endpoints resolve
  the org from the key; `tools` and `usage` need `/api/orgs/{org}` — `resolveOrgId()`
  fetches it once (`GET /api/orgs`) and caches it in config.
- **Command contract**: each `src/commands/*.mjs` exports `run(sub, args, flags)`.
  `sub` = the subcommand (for `chat` it is the agent id); `args` = remaining
  positionals; `flags` = parsed `--k v` / `--bool` / `-m` (plus global `--json`).
- **Output**: human tables by default; `--json` everywhere for scripting/`jq`.
  A write whose route answers `204` still answers in JSON — `printMutation(payload,
  ack)` in `ui.mjs` prints the server body when there is one and an explicit
  `{deleted: id}`-shaped acknowledgement when there is not. A bare `ok()` after a
  `del`/`post` is the bug `test/json-contract.test.mjs` exists to catch.
- **`fatal(msg, code)`**: a command that catches an `ApiError` to reword it MUST
  pass `exitCodeFor(e)`, or a 404 rephrased as "already removed?" exits 1 and a
  script can no longer tell it from a bad key. Also caught by that suite.
- **Batch commands** (`calls campaign`, `calls export`) set `process.exitCode` from
  `batchExitCode()` — the code every failure agrees on, else 1. They used to exit 0
  no matter how many rows failed.
- **Errors**: `api.mjs` throws `ApiError` with a friendly message (401→login,
  402→top up, 403→scope); the entry point prints it and exits via
  `exitCodeFor()`.
- **Exit codes** (`src/exit.mjs`, documented in `whissle help` + README): `0` ok,
  `1` generic, `2` auth (401/403, or a client-side `no_key`/`no_org`), `3` not
  found (404), `4` out of credit (402). They are a public contract — a script
  branches on them, so changing one is a breaking change.
- **Help**: `whissle <group> --help` works for every group. `helpFor()` in
  `bin/whissle.mjs` SLICES the master `HELP` string rather than duplicating it —
  24 hand-maintained help blobs would drift within a release. A line belongs to a
  group when it starts with `whissle <group>`; hanging-indented lines and
  bracketed asides come with it, a word at the command column is the next
  section's sub-heading and does not.

## Adding an endpoint

Two steps, two files — never inline a `/api/…` string in a command:

1. **Path** → add it to the right domain group in `src/endpoints.mjs` (`EP.*`). Static
   path = string; parameterized/org-scoped = a builder fn (org id first). This is the
   ONLY place API paths live.
2. **Call** → in a `src/commands/*.mjs`, `import { EP }` and pass the path into
   `get/post/patch/del/upload/raw` from `src/api.mjs`. If org-scoped, `await
   resolveOrgId()` first and pass the org id into the `EP.*` builder. Query params and
   request bodies stay in the command.

Verify the request/response shape against the backend route in
`whissle_gateway_backend/pipecat-bot/routes/`.

## Dependencies

Minimal: `chalk`, `marked`, `marked-terminal`. Everything else is Node built-ins.
