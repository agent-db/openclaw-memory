---
name: agentdb-fleet
description:
  Coordinate multiple OpenClaw agents through one shared AgentDB workspace — a
  durable task queue and shared state built from Schema.org entities, with
  per-agent identities and permission boundaries. Use when running an agent
  fleet (Discord squads, worker pools, multi-device setups) that needs handoffs
  without shared files.
homepage: https://github.com/agent-db/openclaw-memory
metadata:
  { "openclaw": { "emoji": "🐝", "requires": { "env": ["AGENTDB_BASE_URL"] } } }
---

# AgentDB fleet coordination

Prerequisite: the `agentdb` skill (envelope, auth, CRUD). This skill adds the
multi-agent pattern: **each worker is its own identity; the workspace is the
shared surface; entities are the queue.**

## Setup (once, by the fleet operator)

1. Every worker pairs with its **own** pairing token (identities must not be
   shared — revoking one worker must not kill the fleet). Tokens come from the
   AgentDB dashboard or the admin provisioning flow.
2. Each worker discovers the shared workspace and its api key:

```json
{
  "@type": "DiscoverAction",
  "object": { "@type": "Organization", "additionalType": "Workspace" },
  "instrument": [
    { "@type": "PropertyValue", "name": "include", "value": "api_key" }
  ]
}
```

All shared reads/writes then use
`location: {"@type":"VirtualLocation","name":"Shared"}` **plus** the
`apikey: <workspace api key>` header.

## The task-queue pattern

A task is a `CreativeWork` whose lifecycle rides on `creativeWorkStatus`:

| Status       | Meaning             |
| ------------ | ------------------- |
| `Draft`      | Filed, unclaimed    |
| `InProgress` | Claimed by a worker |
| `Blocked`    | Needs another agent |
| `Published`  | Done                |

**File work** (any agent):

```json
{
  "@type": "CreateAction",
  "location": { "@type": "VirtualLocation", "name": "Shared" },
  "object": {
    "@type": "CreativeWork",
    "additionalType": "FleetTask",
    "identifier": "task-2026-0142",
    "name": "Summarize this week's support threads",
    "text": "Pull the tagged threads, produce one digest per product area.",
    "creativeWorkStatus": "Draft"
  }
}
```

**Poll for work** (workers):

```json
{
  "@type": "SearchAction",
  "location": { "@type": "VirtualLocation", "name": "Shared" },
  "object": {
    "@type": "CreativeWork",
    "additionalType": "FleetTask",
    "creativeWorkStatus": "Draft"
  }
}
```

**Claim before working** — flip the status and stamp yourself, then re-read to
confirm your claim stuck (last-write-wins; the re-read is the guard):

```json
{
  "@type": "UpdateAction",
  "location": { "@type": "VirtualLocation", "name": "Shared" },
  "object": {
    "@type": "CreativeWork",
    "identifier": "task-2026-0142",
    "creativeWorkStatus": "InProgress",
    "contributor": { "@type": "Person", "name": "worker-emma" }
  }
}
```

**Hand off** — set `Blocked`, put what the next agent needs in `text`, and name
them in `contributor`. **Finish** — set `Published` with the result (or a
pointer to a result entity) in `text`.

## Rules that keep a fleet sane

- **One identifier scheme** (`task-<date>-<seq>` or similar), agreed once —
  identifiers are how agents reference work across sessions.
- **Claim, verify, then work.** Two workers may race the same Draft; the loser's
  re-read shows the other worker's name and it moves on.
- **Private stays private.** Worker scratch state goes to the worker's own
  `Private` domain **without** the workspace `apikey` header — attaching the
  workspace key reroutes the write into the workspace's shared-private store,
  where every fleet peer can read the row (PII fields like `email`/`telephone`
  come back as masked `pii:ref:*` placeholders for everyone but the writer, but
  the rest of the row is visible). Only coordination state goes to `Shared`.
- **Don't share tokens.** A worker that leaks or loses its token gets re-paired
  individually; the workspace and other workers are unaffected.
- **Poll politely.** Space out queue polls (30s+); on `429` honor `Retry-After`.
