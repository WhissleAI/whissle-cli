# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

`whissle` is the command-line interface for the **Whissle Voice Agents platform**
(the gateway at `aws-gateway-backend.whissle.ai/bot`). It lets a user **configure**
agents, **run** them (text chat), and **pull records** (calls, transcripts,
recordings, usage) for their own evaluation and logs. Node.js ESM, no build step.

It is the server-side companion to `@whissle/agents` (the browser voice-embed SDK
in `SDKs/agents_js_sdk`): the SDK *runs* an agent in a web page with a publishable
`wpk_` key; this CLI *manages* the workspace with a secret `wsk_` key.

> Note: this project used to be a terminal *coding assistant* (SSE REPL against
> `api.whissle.ai`, local read/write/bash tools). That was fully removed and
> replaced — do not resurrect it.

## Commands

```bash
npm install
node bin/whissle.mjs            # or `whissle` after `npm link`
node bin/whissle.mjs help
```

## Architecture

```
bin/whissle.mjs        entry — arg/flag parse, group dispatch, help, error handling
src/config.mjs         ~/.whissle/config.json (0600) + env overrides (WHISSLE_API_KEY, WHISSLE_BASE_URL)
src/api.mjs            gateway REST client — bearer auth, JSON/multipart/raw, error surfacing, resolveOrgId().
                       Self-contained (no CLI imports) so it can become @whissle/sdk. THE place to add endpoints.
src/ui.mjs             chalk table/kv/json/markdown(marked-terminal)/spinner. Brand accent #e5484d.
src/commands/
  config.mjs           login / logout / whoami / config
  agents.mjs           list / get / create / update / delete   (agents:read/write)
                       create --file agent.json = full package: create + PATCH audio/config + ingest knowledge.
                       CREATE_FIELDS vs PATCH_FIELDS decide the two-step apply — keep examples/README.md in sync.
  chat.mjs             interactive + one-shot text turn → POST /api/agents/{id}/chat/turn
  calls.mjs            start / campaign / list / get / transcript / audio / export
                       start = one outbound call; campaign = one call per CSV row (each column ->
                       a dynamic {{variable}}, --to-col picks the callee, gated by --dry-run/--yes).
                       start/campaign take --var k=v / --vars-file. (calls:read records; calls:write to place)
  kb.mjs               list / add (text|file|url)               (kb:read/write)
  tools.mjs            list / create / attach                   (org-scoped: /api/orgs/{org}/tools)
  connectors.mjs       list / add / remove                      (connectors:read/write; org-scoped: /api/orgs/{org}/credentials)
                       stored org credentials, e.g. a FHIR/EHR server — an agent's fhir_* tools resolve them.
  embed.mjs            show / enable / disable                  (agents:read/write; /api/agents/{id}/embed) — voice widget on a site
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
- **Errors**: `api.mjs` throws `ApiError` with a friendly message (401→login,
  402→top up, 403→scope); the entry point prints it and exits non-zero.

## Adding an endpoint

Add the request to a command in `src/commands/` using `get/post/patch/del/upload/raw`
from `src/api.mjs`. If the endpoint is org-scoped, `await resolveOrgId()` first.
Verify the request/response shape against the backend route in
`whissle_gateway_backend/pipecat-bot/routes/`.

## Dependencies

Minimal: `chalk`, `marked`, `marked-terminal`. Everything else is Node built-ins.
