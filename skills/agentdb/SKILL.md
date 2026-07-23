---
name: agentdb
description:
  Store, search, and manage structured memory and data on AgentDB — one
  Schema.org JSON-LD endpoint for create/find/search/update/delete, semantic
  recall, and workspace discovery. Use when the user asks to remember something
  durably, recall past facts, or keep structured records that survive devices
  and sessions.
homepage: https://github.com/agent-db/openclaw-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "🗄️",
        "requires": { "env": ["AGENTDB_BASE_URL"] },
        "primaryEnv": "AGENTDB_PAIRING_TOKEN",
      },
  }
---

# AgentDB — durable structured memory over one endpoint

AgentDB stores **Schema.org JSON-LD entities**. Everything below is a JSON body
POSTed to one endpoint. Use `curl` via exec, or the plugin's automatic
capture/recall if `agentdb-memory` is enabled.

```
POST $AGENTDB_BASE_URL/api/action
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

## Getting a token (once)

Credentials persist in `~/.openclaw/agentdb/credentials.json` — check there
first. Otherwise, in order of preference:

1. **Pairing token** (`AGENTDB_PAIRING_TOKEN`, single-use — from the AgentDB
   dashboard or your admin):

```bash
curl -s -X POST "$AGENTDB_BASE_URL/api/agents/pair" \
  -H 'Content-Type: application/json' \
  -d '{"pairing_token":"'"$AGENTDB_PAIRING_TOKEN"'"}'
# → { "access_token", "refresh_token", "expires_in" } — save both tokens
```

2. **Self-service email login** (no token at all): ask the user for their email,
   then run the OTP round-trip. The first login auto-creates their free
   organization.

```bash
# request the code (it is emailed to the user — ask them for it)
curl -s -X POST "$AGENTDB_BASE_URL/api/action" -H 'Content-Type: application/json' \
  -d '{"@type":"LoginAction","object":{"@type":"Person","email":"<EMAIL>"}}'
# verify with the 6-digit code the user gives you → result.text is the JWT
curl -s -X POST "$AGENTDB_BASE_URL/api/action" -H 'Content-Type: application/json' \
  -d '{"@type":"LoginAction","object":{"@type":"Person","email":"<EMAIL>"},
       "instrument":[{"@type":"PropertyValue","name":"code","value":"<CODE>"}]}'
```

When a request returns **401**, rotate: `POST /api/agents/token` with
`{"refresh_token":"<REFRESH_TOKEN>"}` → new token pair. If rotation also fails,
re-pair with a fresh pairing token.

## The two rules that matter

1. **Data actions carry a `location`** (which visibility domain to write to):
   `{"@type":"VirtualLocation","name":"Private"}` — `Private` for this agent's
   own memory, `Shared` for workspace-visible data (add the workspace `apikey`
   header), `Public` for directory data. Omitting `location` routes to the admin
   plane and fails with `INVALID_ACTION`.
2. **Payloads are validated Schema.org.** Use real types (`CreativeWork`,
   `Person`, `Event`, `Message`, `Product`, …) and real properties. Your own
   subtype goes in `additionalType` (e.g. a "Task" is a `CreativeWork` with
   `"additionalType":"Task"`), never an invented `@type`.

## Core operations (all `POST /api/action`)

**Remember** — create an entity:

```json
{
  "@type": "CreateAction",
  "location": { "@type": "VirtualLocation", "name": "Private" },
  "object": {
    "@type": "CreativeWork",
    "additionalType": "Memory",
    "name": "Dentist appointment",
    "text": "User's dentist appointment is Aug 12, 3pm, Dr. Meyer",
    "keywords": "health, appointments"
  }
}
```

**Recall** — semantic search (`similarTo`); use `like` for exact substring:

```json
{
  "@type": "SearchAction",
  "location": { "@type": "VirtualLocation", "name": "Private" },
  "object": {
    "@type": "PropertyValue",
    "identifier": { "@type": "PropertyValue", "value": "CreativeWork" },
    "valueReference": [
      {
        "@type": "PropertyValue",
        "name": "text",
        "value": "when is the dentist",
        "measurementMethod": [{ "@type": "DefinedTerm", "name": "similarTo" }]
      }
    ]
  },
  "instrument": [{ "@type": "PropertyValue", "name": "limit", "value": 5 }]
}
```

**Fetch one** —
`{"@type":"FindAction","location":…,"object":{"@type":"CreativeWork","identifier":"<ID>"}}`

**Update** —
`{"@type":"UpdateAction","location":…,"object":{"@type":"CreativeWork","identifier":"<ID>","text":"<new text>"}}`

**Delete** —
`{"@type":"DeleteAction","location":…,"object":{"@type":"CreativeWork","identifier":"<ID>"}}`

**List by subtype** —
`{"@type":"SearchAction","location":…,"object":{"@type":"CreativeWork","additionalType":"Memory"}}`

Responses echo the action with the entity in `result` (searches return an
`ItemList` in `result.itemListElement`). Store the returned `identifier` / `@id`
when you'll need to update or delete later.

## Workspace discovery (multi-agent / shared data)

To find workspaces you can reach — and the `apikey` for their shared data — send
(no `location`, this is the admin plane):

```json
{
  "@type": "DiscoverAction",
  "object": { "@type": "Organization", "additionalType": "Workspace" },
  "instrument": [
    { "@type": "PropertyValue", "name": "include", "value": "api_key" }
  ]
}
```

Then write shared entities with `location.name = "Shared"` plus the
`apikey: <workspace api key>` header. For the full fleet pattern see the
`agentdb-fleet` skill.

## Errors

| Status                     | Meaning              | Do                                                        |
| -------------------------- | -------------------- | --------------------------------------------------------- |
| 400 with validation detail | Schema.org violation | Fix the type/property — don't retry unchanged             |
| 401                        | Token expired        | Rotate via `/api/agents/token`, then retry once           |
| 402                        | Billing cap          | Tell the user; reads still work                           |
| 403                        | Not permitted        | Wrong domain or workspace — check `location` and `apikey` |
| 429                        | Rate limited         | Wait for `Retry-After`, then continue                     |

Never invent base URLs, tokens, or identifiers — ask the user or discover them.
Never print tokens into chat; refer to them by env var name.
