# Outbound call campaigns

Drive outbound voice-agent calls from the CLI — one call, or a whole CSV of them —
passing **dynamic variables** that fill `{{placeholders}}` in the agent's prompt.
This folds the [`whissle_agents_n8n_demo`](https://github.com/WhissleAI/whissle_agents_n8n_demo)
flow into the CLI: no n8n or hand-rolled `curl` needed.

Needs a `wsk_` key with the **`calls:write`** scope and a number bound to the agent
(the caller ID). See `whissle numbers` and the agent's Phone tab.

## One call, with variables

```bash
# Inline variables (repeatable --var), or a JSON file, or both (merged):
whissle calls start --agent <agent-id> --to +12138224814 \
  --var user_first_name=Karan --var need_appointment=true

whissle calls start --agent <agent-id> --to +12138224814 \
  --vars-file examples/campaigns/vars.example.json
```
Each key must match a `{{variable}}` in the agent's prompt exactly. The only
structurally-required field is the callee (`--to`).

## A campaign from CSV

`patients.csv` here has the columns the demo Medical-Follow-up agent's prompt uses.
Every column becomes a dynamic variable; `--to-col` names the phone column.

```bash
# ALWAYS preview first — this places real, billed calls to real people:
whissle calls campaign --agent <agent-id> --file examples/campaigns/patients.csv \
  --to-col user_phone_number --dry-run

# Then place them (--yes is required; --dry-run/--yes gate it against accidents):
whissle calls campaign --agent <agent-id> --file examples/campaigns/patients.csv \
  --to-col user_phone_number --concurrency 3 --delay 1000 --yes
```
- `--concurrency N` — calls placed in parallel (default 3).
- `--delay MS` — pause per worker between calls, to respect rate limits.
- `--from +1…` — override the caller ID for the whole batch.
- `--json` — machine-readable `[{to, ok, call_id|error}]` for scripting.

Bring your own CSV: any header row works — the column names are your variable
names, so match them to your agent's prompt. Point `--to-col` at whichever column
holds the E.164 number.

## Pull the results

Each placed call returns a `call_id`; after they finish:

```bash
whissle calls export --agent <agent-id> --format csv --out results.csv   # transcripts + dispositions
whissle calls get <call-id>          # one call: status, disposition, summary
whissle calls transcript <call-id>
```
