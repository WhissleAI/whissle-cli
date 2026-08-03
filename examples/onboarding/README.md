# Onboarding a client, end to end

A single flow that takes a fresh Whissle workspace to a running outbound campaign
with analytics — using only the CLI. Every step is a real command; `--json` works
on all of them for scripting.

Prerequisites: a workspace secret key (`wsk_…`). Set it once:

```bash
whissle login                 # paste the wsk_ key   (or: export WHISSLE_API_KEY=wsk_…)
whissle whoami                # confirm the workspace
```

## 1. Issue the client their own API key

The secret is shown **once** at creation — capture it immediately.

```bash
whissle keys create --name "Acme Prod" --scopes agents:read,agents:write,calls:read,calls:write,contacts:write
# → prints id, prefix, and the full secret (copy it now)
whissle keys list
```

For a browser voice embed, mint a publishable key instead:

```bash
whissle keys create --name "Acme Web" --publishable --origins https://acme.com
```

## 2. Invite a teammate

```bash
whissle team invite --email ops@acme.com --role admin
whissle team list
```

## 3. Connect an integration (optional)

Give agents external tools via the MCP connector store:

```bash
whissle integrations catalog
whissle integrations add --name "Acme CRM" --url https://mcp.acme.com --auth-mode bearer --token "$CRM_TOKEN"
whissle integrations connect <integration-id>          # test the handshake
# For OAuth providers instead:
#   whissle integrations add --name GitHub --url https://… --auth-mode oauth
#   whissle integrations connect <integration-id> --oauth   # prints an authorize URL to open
```

## 4. Create the agent

```bash
whissle agents create --file ../agents/customer-support.json    # see examples/agents/README.md
AGENT=$(whissle agents list --json | jq -r '.[0].id')
```

Attach the integration's tools to it:

```bash
whissle integrations attach <integration-id> --agent "$AGENT"
```

Ground every agent with company facts (the Company Brain):

```bash
whissle memory add --text "Acme support hours are 9-5 ET, closed on federal holidays."
```

## 5. Import the contacts

Contacts are agent-scoped, so pass `--agent`. The CSV needs a `phone_number`
column (or map one). Unknown columns become custom call variables.

```bash
whissle customers import --file contacts.csv --agent "$AGENT" --on-duplicate update
#   differently-named phone column?  add:  --map Mobile=phone_number
whissle customers list --agent "$AGENT"
```

## 6. Run a server-side campaign

This is the **managed** campaign (the engine dials at a paced rate) — distinct
from `whissle calls campaign`, which places calls from your own machine.

```bash
cat > campaign.json <<JSON
{ "name": "Acme reminders", "agent_id": "$AGENT", "calls_per_hour": 60,
  "window_start": 9, "window_end": 17, "timezone": "America/New_York" }
JSON

whissle campaigns create --file campaign.json
whissle campaigns list
whissle campaigns action <campaign-id> pause      # pause | resume | cancel
```

## 7. Pull analytics

```bash
whissle analytics options                                    # valid metrics + dimensions
whissle analytics query --metric success_rate --group-by day --days 7 --agent "$AGENT"
whissle analytics query --metric count --group-by disposition --since 2026-07-01 --until 2026-07-31
```

## Also available

- `whissle appointments …` — per-agent business hours, blocked dates, calendar status.
- `whissle sms messages | opt-outs | consents` — the SMS delivery + A2P consent log.
- `whissle meetings schedule --url https://meet.google.com/…` — send a notetaker.

> Some management surfaces (`integrations`, `team`, `appointments`, `sms`,
> `meetings`, `memory`) are being made `wsk_`-key-authable in a parallel backend
> change; they light up for CLI key auth once that lands.
