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
| `knowledge/bosch-wat28400uc-washer.md` | Bosch 300 Series front-loader: `E:18` pump blocked, `E:32` unbalanced load, `E:93` hot tap |
| `knowledge/bosch-wat28401uc-washer.md` | the next model up, one digit apart — **same three codes, no `E:23`** |
| `knowledge/bosch-wat28402uc-washer.md` | one digit apart again, and the only one of the three documenting **`E:23`** — a stop-use leak |
| `knowledge/lg-wt901cw-washer.md` | a **top-loader**, and letter codes instead of `E:nn`: `IE` inlet filter, `CL` child lock |
| `knowledge/miele-wwb020-washer.md` | **no fault codes at all** — indicator lights, symptom-organised, and a drain-filter clean filed under a door-release heading |

## What is real here, and what is not

Two different things sit in `knowledge/`, and the distinction matters.

**The five manuals are real.** They are approved extracts from the manufacturers'
own published documentation — Bosch, LG and Miele — for models that exist, with the
error codes and procedures those documents actually carry. They are extracts, not
full manuals, and each file opens with a banner saying so and disclaiming
affiliation. ApplianceCare is not affiliated with, authorised by, or endorsed by
Bosch/BSH, LG Electronics, or Miele; the names appear as factual references to
published documentation. Grounding the example in real specifications is the point:
you cannot tell whether an agent is *right* if the manual it is answering from was
invented.

**The support policy is synthetic**, and so is everything about customers.
`appliancecare-support-policy.md` is a benchmark policy written for this example —
it is **not** any manufacturer's real support, warranty, repair, or dispatch
policy, it names no manufacturer, and it must never be presented as one. Any
customer records, serial numbers, purchase dates, or warranty entries you see
alongside this example are likewise invented; no real person or registration is
represented.

If you adapt this package, replace the policy with your own, and replace the
manuals with documentation you are licensed to use.

The conflicts between the manuals are the reason there are five. The three Bosch
models differ by one digit and do **not** document the same codes; LG uses a
different code convention entirely; Miele uses none. An agent that skips model
identification and gives generic advice will be wrong in a way you can see. Keep
that property if you edit them.

## The tool set is deliberately minimal

`search_knowledge_base` and `take_message`, and nothing else. No `send_sms`, no
appointment or booking tools, no connectors, no integrations.

Because of that, **this agent cannot book or dispatch a service visit, check a
warranty record, or look up an account** — and the prompt says so explicitly. It
records a message or a safety escalation for the service team instead. If you add
those capabilities, update the prompt in the same commit, or the agent will start
promising things it cannot do.

**Automatic post-call actions are explicitly disabled here.** Every supported
disposition maps to no automatic tool and no follow-up action, so the
`customer_support` blueprint cannot silently add an SMS, callback, transfer, or
follow-up call. Sensitive actions remain listed in `action_policy` as `approve`,
which means a human must approve them in the Action Inbox.

After creation, use `whissle agents get <id>` to verify that the effective
`disposition_tool_map`, `further_action_map`, and `action_policy` still match the
package.

## Try it

```bash
whissle agents create --file examples/agents/appliance-care/agent.json   # → prints the id
whissle kb list <id>                                                     # 6 documents

# does it ask for the model instead of guessing?
whissle chat <id> -m "My washing machine is not draining."

# does it actually read the manual? (E:23 is documented on the WAT28402UC ONLY,
# and the documented answer is stop-use: turn off the tap, call service)
whissle chat <id> -m "What does E:23 mean on a Bosch WAT28402UC?"

# does the safety rule fire?
whissle chat <id> -m "There's a burning smell but I want to finish the load."

whissle chat <id>                                                        # interactive
whissle agents delete <id> --force
```

The second probe is the one that proves knowledge ingestion worked — a
plausible-sounding answer that does not match the file means the KB is not being
consulted.
