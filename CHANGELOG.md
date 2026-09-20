# Changelog

## 1.6.0 — 2026-09-20

Whissle's own speech engine became self-serve on the platform this week: a
workspace secret key carrying `models:invoke` now opens it. This release reaches
it — and fixes four flags that were being sent to the gateway and dropped in
silence.

> **npm is one release behind.** 1.5.0 was never published, so `listen`,
> `vision`, `webhooks`, `kb sync` and `chat turn --schema/--cite` are in this
> repo and not yet installable from npm. `npm i -g github:WhissleAI/whissle-cli`
> until the next publish.

### Added

- **`whissle models transcribe --engine whissle|deepgram|sarvam`** — the
  platform gained an `engine` form field, so you can finally ask for **Whissle's
  own** transcript rather than whatever the language map picks. It is the only
  engine that also returns a `metadata` block (emotion, intent, age, gender,
  role, … with confidences) beside the words; the other two are third parties
  that return text.

  The platform **degrades rather than failing**: ask for an engine this
  deployment cannot reach and a perfectly ordinary-looking transcript arrives
  from a different one, with a `warnings` entry saying so. Those warnings now
  print **first, on stderr, before the text**, and the footer names the `engine`
  that actually **ran** plus which metadata tags came back. A transcript that
  quietly changed provenance looks exactly like one that did not, which is the
  whole reason this is surfaced rather than buried in `--json`.

  Omitting `--engine` sends byte-identical bytes to what 1.5.0 sent.

- **`whissle asr`** (new group) — the speech engine itself.

  - `asr status` — engine, models, decoder, LM languages, device. It says out
    loud that it does **not** list which metadata heads are loaded, because no
    endpoint does.
  - `asr stream <file.wav|->` — opens `wss://<gateway>/asr/stream?token=wsk_…`
    (the token is a query parameter because a browser cannot set a header on a
    WebSocket), sends the JSON config frame, streams s16le mono PCM and renders
    the transcript events: finals by default, `--partials` for interim,
    metadata tags inline, `--json` for NDJSON of every frame exactly as the
    engine sent it. Flags: `--language`, `--metadata a,b|none`,
    `--word-timestamps`, `--hotwords`, `--sample-rate`, `--realtime`.

  **It does not open your microphone, deliberately.** Node has none, and
  capturing one means a native addon or a hard dependency on a sound stack —
  a control-plane CLI that fails at `npm i -g` on a machine without one is
  worse than a CLI that never claimed to record. This command owns the
  protocol; you own the audio:
  `ffmpeg -f avfoundation -i :0 -f s16le -ar 16000 -ac 1 - | whissle asr stream -`.
  A mono 16-bit WAV is read directly; any other layout is refused **with the
  conversion command** rather than reinterpreted into confident garbage.

  **Billing is stated wherever the socket is:** metered per second the socket is
  **open** — wall clock on the gateway relay, not the duration of the audio.
  An idle open socket still bills. The default therefore sends as fast as the
  socket will take it and closes the moment the input ends.

  `whissle asr stream` and `whissle listen` are **different features** and each
  group's help, and the README, now says so: `listen` puts an **agent** in a
  LiveKit room.

- `whissle webhooks events [--offline]` now reads the **live** event vocabulary
  from `GET /api/webhooks/events`, and `webhooks create` validates `--events`
  against it. The built-in list is the offline fallback.

### Fixed

Four flags were mapped onto fields no handler declares. pydantic ignores keys a
body model does not have, so none of them errored — each one succeeded and told
the caller the thing they asked for had happened.

- **`whissle sms send --from` was silently dropped.** `SmsSendBody` is
  `to_number` + `body` + `agent_id`. The message went out from whichever number
  the server resolved — a **different sender than the one named**. The field is
  gone; `--from` now warns and says the number comes from `--agent`, else the
  workspace default.
- **`whissle alerts rules --webhook` was silently dropped.** Nothing in the
  alerts router reads a `webhook_id`: a firing fans out to **every** endpoint in
  the workspace subscribed to that event. Targeting one is not a feature that
  exists, and the flag and its documentation are removed.
- **`whissle alerts rules update --kind/--door` were silently dropped.** They
  are create-only — the update route's patch model has neither, so the PUT
  answered 200 with the rule unchanged, reading exactly like a successful edit.
  The CLI now refuses and names the remedy (delete, re-create).
- **`whissle kb add --file --title` was silently dropped.** The upload route
  takes `file` and nothing else and titles the document from its filename, so
  the document appeared under a name the caller never chose. `--title` on an
  upload now warns and points at `kb update --title`.

### Documentation

- **`whissle analytics query --start/--end` did not exist** — the command reads
  `--since`/`--until` (and maps them onto the request's `start`/`end`, which is
  where the wrong names came from). Corrected.
- **`whissle keys create --type secret|publishable` did not exist** — the
  command reads `--publishable`. Corrected.
- The transcription section no longer claims the engine "is never exposed", and
  documents the real `--json` payload (`text`, `segments[]`, `duration_seconds`,
  `diarized`, `cost_usd`, and the conditional `engine` / `metadata` /
  `warnings`) rather than a subset of it.
- New README section for the speech engine, including the `listen` vs
  `asr stream` distinction, the per-second-open billing, and the standing
  warning that **metadata is a request, not a promise**: whether a tag comes
  back depends on the model this deployment loaded, the smallest English model
  has no metadata head at all, and `asr status` cannot tell you in advance.
- Documented as a deliberate limit, not a gap: `/asr/translate` and `/asr/s2s`
  are **not** reachable with a workspace key — they compose speech with a
  language model and those legs have no per-second price, so a `wsk_` there
  would be an unbilled door.

### Tests

219 → 251, all passing. Two new suites:

- `test/docs-contract.test.mjs` — every `--flag` shown on a `whissle <group> …`
  line in the README, the `--help` text or an examples README must be a flag the
  command actually reads. This is the check that would have caught the two
  stale flags above before they shipped.
- `test/silent-drops.test.mjs` — pins each of the four dropped fields, so none
  of them can quietly come back.

Plus `test/asr.test.mjs` for the engine flag, the gateway-origin derivation, the
config frame, WAV/PCM layout handling and event rendering.

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
