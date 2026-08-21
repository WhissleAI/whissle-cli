# Example agents

Ready-to-use agent **packages** for `whissle agents create --file <path>`. A
package is a single JSON (optionally with a `knowledge/` folder beside it). The
CLI creates the agent, applies its audio/config settings, and ingests its
knowledge — in one command.

```bash
whissle agents create --file examples/agents/dental-clinic/agent.json
```

## The tiers

Each example is fuller than the last — copy the one closest to your use case.

| Tier | Example | What it shows |
|---|---|---|
| **Simple** | `agents/customer-support.json` | Prompt + greeting + type, a few tools, and the full audio block. The minimum that still sounds human. |
| **Medium** | `agents/dental-receptionist.json`, `agents/lead-qualification.json` | Adds variables, a real tool set, and (lead) the outbound **automation maps** — post-call tools, follow-up scheduling, and approval policy. |
| **+ Knowledge** | `agents/dental-clinic/` | Everything above **plus** a `knowledge/` folder ingested into the KB for RAG-grounded answers. This is the flagship — it sets *every* supported field. |
| **+ Connector** | `agents/patient-checkin-fhir/` | Adds the FHIR/EHR tool set — a live connector. Configure an EHR credential in the workspace first — `whissle connectors add --kind fhir --name "…" --base-url … --auth …` (see the file's `_setup_note`) — and the agent's `fhir_*` tools resolve it automatically. |
| **+ Grounded support** | `agents/appliance-care/` | Knowledge the agent must answer *from*: five **real** washing-machine manual extracts (Bosch, LG, Miele) whose codes and procedures genuinely conflict between models — three Bosch models differ by one digit and do not document the same codes — plus a **synthetic** support policy and safety rules that stop troubleshooting. Shows a deliberately **minimal** tool set, a prompt scoped to exactly what those tools can do, and explicit prevention of automatic post-call actions. |

Every agent created this way is **both web-embeddable and reachable by phone** —
run `whissle embed enable <id>` for the widget, or `whissle numbers connect` to
attach a phone number. The package format below is channel-agnostic.

## Field reference

Everything in `AgentCreate` / `AgentUpdate` is accepted. `name` +
`system_prompt` are the only required fields; everything else has a sensible
default. Keys beginning with `_` (e.g. `_setup_note`) are treated as comments and
ignored.

### Identity & behaviour
| Field | Type / values | Notes |
|---|---|---|
| `name` | string | **Required.** |
| `system_prompt` | string | **Required.** `prompt_seed` (a `whissle_agent_data` manifest alias) also works. |
| `greeting` | string | First line spoken. Supports `{{var\|default}}` placeholders. |
| `agent_type` | `general` · `customer_support` · `lead_qualification` · `dental_receptionist` · `appointment_scheduling` · `appointment_reminder` · `renewal_reminder` · `debt_collection` · `sales_handoff` · `survey_feedback` · `medication_checkin` · `patient_checkin` · `car_rental` · `companion` · `ai_tutor` · `skills_exam` · `text_assistant` | Selects the blueprint (disposition schema, default tools, scoring). |
| `direction` | `inbound` · `outbound` | |
| `variables` | `[{ "key", "label" }]` | Runtime `{{key}}` substitutions. |

### Voice & language
| Field | Type / values | Notes |
|---|---|---|
| `voice_gender` | `female` · `male` | The friendly voice knob. |
| `voice` | string (optional) | A specific TTS voice id. Omit to use the gender default. |
| `language_mode` | `lock` · `auto` · `multilingual` | `lock` = one language; `auto` = follow the caller; `multilingual` = mix freely. |
| `video_enabled` | boolean | Enables the avatar / camera surface for web sessions. |

### Audio — humanizer, soundscape, sounds
Humanizer + soundscape + inline sounds are ON by default platform-wide; set these to override per agent.

| Field | Type / values | Notes |
|---|---|---|
| `audio_ambience` | `studio` · `room` · `office` · `outdoor` · `phone` | The acoustic "room" the **voice** sits in. `studio` = clean; `room` = subtle presence. |
| `audio_humanizer_intensity` | float `0`–`3` (default `1.0`) | How strongly the humanizer breathes/varies the voice. `0` = off, `1` = natural, `>1` = more. |
| `ambient_scene` | `none` · `room` · `office` · `cafe` · `street` · `outdoor` · `nature` · `rain` | A procedural **background bed** under the call. `room` is the subtlest; `none` = silent. |
| `ambient_level_db` | float (e.g. `-38`) | Loudness of the background bed. More negative = quieter. |
| `audio_inline_sounds` | boolean | Lets the agent place non-verbals (a soft laugh, a beat of thought) inline. |
| `tool_sounds` | `off` · `ui` · `call` | Who hears the earcon a tool call makes. `ui` = studio browser only (default); `call` = also mixed into the phone caller's audio; `off` = silent (common for outbound). |

### Tools
| Field | Type | Notes |
|---|---|---|
| `tools` | `["name", …]` or `[{ "name", "enabled", "config" }]` | Built-in + custom tools to enable. Bare names are shorthand for `{name, enabled:true}`. |

### Post-call automation (outbound / workflows)
These drive what happens **after** a call, keyed by the call's disposition (the
outcome the summarizer assigns — e.g. dental: `booked` · `rescheduled` ·
`cancelled` · `message_taken` · `no_response`; lead: `qualified` ·
`callback_requested` · `not_interested` · `no_response`). Omit them to inherit the
agent-type's defaults.

| Field | Shape | Notes |
|---|---|---|
| `disposition_tool_map` | `{ "<disposition>": ["tool_name", …] }` | Post-call tools to run for a given outcome (e.g. text a confirmation after `booked`). Authoritative over the blueprint default. |
| `further_action_map` | `{ "<disposition>": { "kind": …, "delay_hours": int, "times_per_day": int, "team": "…" } }` | The "what next" policy. `kind`: `followup` / `repeat_until_dpd` schedule a call; `route_to_team` / `issue_tracker` / `escalate` raise an Action-Inbox task; `none` = stop. |
| `action_policy` | `{ "tool_name": "auto" \| "approve" }` | Whether a post-call action fires immediately (`auto`) or waits for a human in the Action Inbox (`approve`). Sensitive tools default to `approve`. |
| `scoring_prompt` | string | Partner-owned rubric for graded verticals (interviews, skills exams). Supports `{transcript}` / `{context}` substitutions. |

### Knowledge
| Field | Shape | Notes |
|---|---|---|
| `knowledge` | `[{ "title", "file" } \| { "title", "text" } \| { "url" }]` | Ingested into the agent's KB on create. `file` paths are relative to the JSON. |

The knowledge markdown in these examples is a mix, and the difference matters if
you reuse it. The washing-machine **manuals** in `agents/appliance-care/knowledge/`
are approved extracts from real published Bosch, LG and Miele documentation, so the
example is grounded in specifications that genuinely exist. Everything else —
support policies, customer records, dispositions — is **synthetic sample data**.
Replace the synthetic content with your own, and the manuals with documentation you
are licensed to use. The structure mirrors the data packages in
[whissle_agent_data](https://github.com/WhissleAI/whissle_agent_data) (manifest +
`knowledge/*.md` + dispositions); a `manifest.json` from there works too (its
`prompt_seed` is read as the system prompt).

## Try one

```bash
whissle agents create --file examples/agents/dental-clinic/agent.json   # → prints the id
whissle chat <id> -m "how much is a cleaning, and are you open Saturday?"  # answers from the KB
whissle embed enable <id>                                                # → web widget snippet
whissle agents delete <id> --force
```
