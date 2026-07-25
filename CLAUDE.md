# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Overview

`whissle` is the command-line interface for the **Whissle Voice Agents platform**
(the gateway at `gateway-backend.whissle.ai/bot`). It lets a user **configure**
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
  chat.mjs             interactive + one-shot text turn → POST /api/agents/{id}/chat/turn
  calls.mjs            list / get / transcript / audio / export (calls:read)
  kb.mjs               list / add (text|file|url)               (kb:read/write)
  tools.mjs            list / create / attach                   (org-scoped: /api/orgs/{org}/tools)
  models.mjs           chat / tts / transcribe                  (models:invoke)
  usage.mjs            wallet balance + ledger                  (/api/orgs/{org}/wallet)
```

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
