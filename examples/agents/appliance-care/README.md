# ApplianceCare — home-appliance support agent

A `customer_support` agent for washing-machine support: identify the exact model,
answer only from that model's manual, guide the customer through
manufacturer-approved steps, and stop and escalate when the situation is unsafe.

```bash
whissle agents create --file examples/agents/appliance-care/agent.json
```

## What is in here

| File | What it is |
|---|---|
| `agent.json` | the agent package — prompt, greeting, audio, tools, knowledge manifest |
| `knowledge/appliancecare-support-policy.md` | support policy: model identification, customer-serviceable vs prohibited actions, stop-and-escalate rules, warranty handling |
| `knowledge/northwind-nw2200-washer.md` | full front-loader manual: error codes, approved reset, drain-filter procedure |
| `knowledge/northwind-nw2200x-washer.md` | same family as the NW-2200, but a **two-filter** drain path — the lint filter must come out first |
| `knowledge/northwind-nw2400-washer.md` | same brand, filter on the **opposite side**, and `E24` means **door lock**, not drain |
| `knowledge/larkfield-lfw70-washer.md` | a **top-loader**: lint trap inside the tub, no kick-panel, no filter cartridge |
| `knowledge/vantis-vt500-washer.md` | abbreviated quick guide with **no customer drain procedure** — that fault is service-only |

## The manuals are synthetic

**Northwind, Larkfield, and Vantis are invented brands, and every manual here was
written from scratch for this example.** Nothing is copied from, derived from, or
downloaded from a real manufacturer's documentation, and no real brand or model is
referenced. Each file opens with a synthetic-data banner. Replace them with your
own content — licensed or your own product's — before using this for anything
real.

The overlap between them is deliberate. Three of the five describe a similar
fault (a machine that will not drain) with **materially different** procedures, so
an agent that skips model identification and gives generic advice will be wrong in
a way you can see. Keep that property if you edit them.

## The tool set is deliberately minimal

`search_knowledge_base` and `take_message`, and nothing else. No `send_sms`, no
appointment or booking tools, no connectors, no integrations.

Because of that, **this agent cannot book or dispatch a service visit, check a
warranty record, or look up an account** — and the prompt says so explicitly. It
records a message or a safety escalation for the service team instead. If you add
those capabilities, update the prompt in the same commit, or the agent will start
promising things it cannot do.

**No post-call automation is configured here** — `disposition_tool_map`,
`further_action_map`, and `action_policy` are all absent. That is not the same as
nothing happening: per [the field reference](../../README.md#post-call-automation-outbound--workflows),
omitted maps **inherit the agent-type blueprint's defaults**, so the
`customer_support` blueprint decides what runs after a session. **Verify what those
defaults do before creating this agent live** — `whissle agents get <id>` after
creation shows the effective configuration. Set the maps explicitly if you need to
guarantee a particular behaviour.

## Try it

```bash
whissle agents create --file examples/agents/appliance-care/agent.json   # → prints the id
whissle kb list <id>                                                     # 6 documents

# does it ask for the model instead of guessing?
whissle chat <id> -m "My washing machine is not draining."

# does it actually read the manual? (the answer must match the NW-2200 file)
whissle chat <id> -m "What does error code E24 mean on the Northwind NW-2200?"

# does the safety rule fire?
whissle chat <id> -m "There's a burning smell but I want to finish the load."

whissle chat <id>                                                        # interactive
whissle agents delete <id> --force
```

The second probe is the one that proves knowledge ingestion worked — a
plausible-sounding answer that does not match the file means the KB is not being
consulted.
