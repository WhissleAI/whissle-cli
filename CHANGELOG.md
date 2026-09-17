# Changelog

## 1.5.0 — 2026-09-16

The platform-contract round: the gateway's new doors (listen, vision, versioned
knowledge, attributed usage, webhooks) and the per-turn fields on the chat turn,
plus the long tail that had endpoints and no verbs. Everything is additive; a
1.4.0 invocation sends exactly the bytes it did before.

> Version note: the shared contract asked for 1.3.0. That number (and 1.4.0)
> had already shipped — `chat --context` and embed-in-create — so this is 1.5.0.

### Added

- **`whissle chat turn <agent> -m "…"`** — the explicit one-shot form, with the
  contract's per-turn fields (which also work on `whissle chat <agent> -m …`):
  `--schema <file>` (`response_schema`; prints `structured`, or the
  `schema_error` in red), `--cite` (`claims` with chunk / doc / version / score,
  and the `retrieved` set), `--context` / `--context-file` (a 413 now says the
  limit and what was sent), `--facts k=v` / `--facts-file`, `--cost-center`,
  `--model-tier fast|default|complex`, `--on-behalf-of` (the
  `X-Whissle-On-Behalf-Of` header), repeatable `--image`, and `--stream`
  (`POST …/chat/turn/stream`, the same `open → delta|tool* → done` frames the
  companion streams; `--json --events` prints every frame). Every turn's footer
  shows `tier … · trace …`.
- **`whissle listen`** (new group) — `start <agent> [--language] [--metadata]`
  opens a listen room and prints `{url, token, room, session_id}`; `tail
  <session> [--interval] [--once]` follows its transcript and signals
  (emotion / intent with `turn_id`, words per minute, speech ms, entity
  disagreements) by polling the session row until `end_reason`, printing only
  what is new. `sessions get` renders `end_reason` and the `delivery` block.
- **`whissle vision`** (new group) — `ask <agent> <image> "<question>"
  [--hint] [--max-words]` (says *(nothing clearly visible)* on `clear:false`)
  and `batch <agent> --file items.json [--concurrency]` (≤ 40 items; paths or
  data URLs).
- **`whissle kb sync <agent> <dir>`** — versioned documents keyed by relative
  path, `PUT` with a sha256 `content_hash` so an unchanged file is one request
  and no re-embed; `--prune`, `--dry-run`, `--namespace`, `--ext`. Plus **`kb
  docs`** (versions + chunks), **`kb search`** (retrieval as the agent sees
  it), **`kb eval <labels.json>`** (recall@1/3/5 + MRR + per-case hit rank),
  **`kb import-conversations <file>`** (the ingest door) and **`kb
  import-status`**.
- **`whissle usage --by agent|cost_center|subject|session [--since] [--until]`**
  — the attribution view (`GET /api/usage`): calls, tokens, seconds and USD per
  group, with a total row.
- **`whissle sessions trace`** for a text session now shows each turn's
  `model_tier`, the `latency_ms` breakdown (retrieve / llm / guard / total),
  chunks retrieved, the guardrail verdict + matched rules, and `cost_usd`.
- **`whissle webhooks`** (new group) — `create --url … --events a,b [--secret]`
  (the secret is printed once, with the signature scheme), `list`, `delete`,
  `test`, `deliveries` (attempts, dead-letters), `replay`, and an offline
  `events` that lists the six event kinds.
- **`whissle alerts create --kind balance_below_usd|p95_ms_over`** — the two
  contract kinds (`--door` for p95, `--webhook` to target one); metric rules
  are unchanged.
- **`whissle actions bulk-approve (--ids … | --all-pending)`**, **`actions
  undo <id>`** (409 → "not undoable", exit 1), and `--idempotency-key` on
  `approve` / `reject` (the `Idempotency-Key` header).
- **`whissle sms send --to … --body … [--from] [--agent]`** — the send route.
- **`whissle numbers provision [--country] [--area-code] [--contains]
  [--agent]`** (search → buy → route) and **`numbers assign`** (alias of
  `connect`).
- `src/api.mjs`: `request()` / `postStream()` take a `headers` option.

### Changed

- The README's package table now points at the Python SDK's repo
  (`whissle-sdk`, `import whissle_sdk`).

## 1.1.0 — 2026-09-01

Gateway parity: CLI surface for platform features that shipped without one.
Every endpoint verified against the gateway's route code.

### Added

- **`whissle alerts`** (new group) — self-service metric thresholds evaluated
  server-side: `rules` / `rules add|update|delete`, `rules test <id>` (measure a
  rule right now — no event, no email, no cooldown consumed), `options` (the
  valid metrics + comparators) and `events` (what actually fired).
- **`whissle usage summary|events|sessions|export`** — the metering view of the
  org (`usage:read`): totals per service + per-day breakdown, raw usage events,
  a per-session breakdown for one day, and the whole window as CSV. Bare
  `whissle usage` stays exactly what it was: the wallet balance + ledger.
- **`whissle voices`** (new group) — the studio voice catalog: what an agent's
  `(voice, voice_gender)` pair actually resolves to at call time, with pricing;
  `--language` / `--gender` filter it.
- **`whissle reports`** (new group) — AI-written transcript reports: `generate`
  (background analyst run, up to 5 of your own `--question`s), list, `show`
  (the finished markdown), and `corpus` (the same transcript window as plain
  text — your data, portable anywhere).
- **`whissle agents scenarios <id>`** + **`whissle agents simulate <id>`** —
  rehearse an agent against persona/goal/criteria scenarios (`generate` drafts
  a suite from the agent's own prompt); runs play against the agent's real
  assembled brain, are judge-scored in the background, and are polled with
  `simulate <id> runs`.
- **`whissle compliance readiness`** — every blocker between the workspace and
  autonomous calling, with the fix for each; **`whissle compliance erase`** —
  GDPR/CCPA erasure (insists on `--force`; keeps the Do-Not-Call entry and the
  erasure event on purpose); `settings set` gains the two one-time attestations
  `--contacts-are-customers` and `--outreach-attested`.

### Changed

- `whissle meetings list` shows each meeting's one-line notes **summary**;
  `meetings get` renders the full notes (summary, key points, decisions, action
  items with owners/due dates).
- `whissle embed token` derives its connect hints from the mint response's
  `transport` descriptor — what the gateway actually advertises (including the
  SFU door and the fallback) — instead of a hardcoded signaling path. Gateways
  that mint without a descriptor get the previous hints.
- `raw()` in the API client accepts `query` params (used by the new CSV/text
  endpoints).
