# Example agents

Ready-to-use agent **packages** for `whissle agents create --file <path>`. A
package is a single JSON (optionally with a `knowledge/` folder beside it). The
CLI creates the agent, applies its audio/config settings, and ingests its
knowledge — in one command.

```bash
whissle agents create --file examples/agents/dental-clinic/agent.json
```

## The tiers

| Tier | Example | What it shows |
|---|---|---|
| **Simple** | `agents/customer-support.json`, `agents/lead-qualification.json` | Just prompt + greeting + type. The minimum. |
| **Medium** (+ knowledge) | `agents/dental-clinic/` | Adds a `knowledge/` folder ingested into the KB, tools, and audio settings. RAG-grounded answers. |
| **Full** (+ connector) | `agents/patient-checkin-fhir/` | Adds the FHIR/EHR tool set — a live connector. Needs an EHR credential configured in the workspace first. |

## The package format

Everything in `AgentCreate`/`AgentUpdate` is accepted; the notable extras:

```jsonc
{
  "name": "…",
  "agent_type": "dental_receptionist",     // see `whissle` help / GET /api/agent-types
  "direction": "inbound",                  // or "outbound"
  "voice_gender": "female",
  "language_mode": "auto",                 // lock | auto | multilingual
  "greeting": "Thanks for calling…",
  "system_prompt": "You are…",             // or "prompt_seed" (manifest.json alias)
  "variables": [{ "key": "clinic_name", "label": "Clinic name" }],

  // Built-in tools to enable — bare names or {name,enabled,config}
  "tools": ["book_appointment", "send_sms", "search_knowledge_base"],

  // Audio (applied via a follow-up PATCH). Humanizer + soundscape + inline sounds
  // are ON by default platform-wide; override per agent here.
  "ambient_scene": "office",               // none|room|office|cafe|street|outdoor|nature|rain
  "audio_inline_sounds": true,
  "audio_humanizer_intensity": 1.0,
  "tool_sounds": "call",                   // off|ui|call

  // Knowledge — ingested into the agent's KB on create. file paths are relative
  // to the JSON. Each item is {title,file} | {title,text} | {url}.
  "knowledge": [
    { "title": "Services & Pricing", "file": "knowledge/services-and-pricing.md" },
    { "title": "Hours", "text": "Mon–Fri 9–6, closed weekends." },
    { "url": "https://example.com/faq" }
  ]
}
```

The knowledge markdown here is **synthetic sample data** — replace it with your
real content. The structure mirrors the data packages in
[whissle_agent_data](https://github.com/WhissleAI/whissle_agent_data) (manifest +
`knowledge/*.md` + dispositions); a `manifest.json` from there works too (its
`prompt_seed` is read as the system prompt).

## Try one

```bash
whissle agents create --file examples/agents/dental-clinic/agent.json   # → prints the id
whissle chat <id> -m "how much is a cleaning, and are you open Saturday?"  # answers from the KB
whissle agents delete <id> --force
```
