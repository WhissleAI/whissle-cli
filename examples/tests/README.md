# Agentic chat harness

Long, multi-turn smoke tests for the example agents. Each scenario **creates** the
agent from its package (the exact `whissle agents create --file` path), drives a
scripted conversation — threading `conversation_id` so context carries the way a
real chat does — captures every reply and the tools each turn used, flags what
looks broken, then **deletes** the agent. It cleans up after itself.

```bash
whissle login --key wsk_live_…                       # once
node examples/tests/agentic-harness.mjs examples/tests/scenarios/*.json
```

Run one, or a subset:
```bash
node examples/tests/agentic-harness.mjs examples/tests/scenarios/dental.json
```

## What it flags

Per turn, split into **hard** findings (real defects — counted in the summary and
the exit code) and **soft** info (calibration, not counted):

| Level | Flag | Means |
|---|---|---|
| ⚠ hard | `tool-trouble` | the model narrated a tool failure ("I'm having a technical issue retrieving…") — this is exactly how the `fhir_get_medications` stash bug surfaced |
| ⚠ hard | `tool-thrash: X ×N` | the same tool was hammered ≥3× in one turn (a retry loop) |
| ⚠ hard | `refusal` | the agent declined to help |
| ⚠ hard | `API error` | the turn request failed |
| ℹ soft | `expected tool not seen this turn` | a turn's `expectTools` weren't called — **often correct** (the agent gathers prerequisites first, or RAG is ambient and never shows as a tool call). Informational only. |

Exit code is non-zero if any **hard** finding fired, so it drops into CI.

## Scenario format

```jsonc
{
  "name": "Dental — front desk",
  "package": "../../agents/dental-clinic/agent.json",  // relative to this file
  "note": "optional — printed before the run (e.g. connector prerequisites)",
  "turns": [
    { "say": "How much is a cleaning?", "expectTools": ["search_knowledge_base"] },
    { "say": "Book me for next Tuesday." }
  ]
}
```

`expectTools` is a soft hint, not an assertion — see the table above.

## Note on the FHIR scenario

`patient-checkin-fhir.json` needs a **FHIR connector** configured in the workspace
(`whissle connectors add --kind fhir --name "…" --base-url … --auth …`)
**and** the `call_id` patient-stash fix deployed (backend PR #450). Without the fix,
`fhir_get_medications` fails after identity is confirmed and the run flags
`tool-trouble` — which is precisely the regression this harness exists to catch.
