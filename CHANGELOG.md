# Changelog

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
