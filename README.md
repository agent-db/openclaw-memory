# @agent-db/openclaw-memory

OpenClaw gateway plugin: long-term, cross-device agent memory backed by
[AgentDB](../agentdb/) — Schema.org JSON-LD entities with semantic recall,
offline-safe writes, and workspace sharing for multi-agent fleets.

Implements Phases 1–4 of
`docs/prd/pending/mcp-tools-and-sdk/OPENCLAW-COMMUNITY-ADOPTION-PRD.md`.

## What ships in this package

| Piece              | Path                            | Purpose                                                                         |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------- |
| Memory engine      | `src/memory.ts`                 | `remember` / `captureMessage` / `recall` (semantic + `like` fallback) / `flush` |
| Identity lifecycle | `src/auth.ts`                   | pairing-token bootstrap, persisted credentials (0600), 401 → rotate → retry     |
| Offline queue      | `src/queue.ts`                  | JSONL write queue; replays on flush, drops server-rejected (4xx) bodies         |
| Hooks adapter      | `src/index.ts`                  | `createMemoryHooks` → `beforePrompt` (inject recall) / `afterMessage` (capture) |
| Gateway entry      | `src/plugin.ts`                 | `definePluginEntry` wiring the engine into OpenClaw's internal hooks            |
| ClawHub skill      | `skills/agentdb/SKILL.md`       | teaches any OpenClaw agent the pairing flow + full action API over `curl`       |
| Fleet skill        | `skills/agentdb-fleet/SKILL.md` | shared-workspace task-queue pattern for multi-agent fleets                      |
| Plugin manifest    | `openclaw.plugin.json`          | registers the `skills/` directory + startup activation with the gateway         |

## Quick start (OpenClaw plugin)

```bash
openclaw plugins install npm:@agent-db/openclaw-memory   # or a packed .tgz
```

Then set the plugin config (or the env fallbacks from the table below) and
restart the gateway. The entry registers three internal hooks:

- `message:received` — captures the user message and records it as the session's
  pending recall query;
- `agent:bootstrap` — at turn preparation, recalls relevant memories for the
  pending query and injects them as a synthetic `AGENTDB_MEMORY.md` context file
  (OpenClaw's plugin API blocks `enqueueNextTurnInjection` after registration,
  so bootstrap mutation is the supported injection path);
- `message:sent` — captures the assistant reply.

With no `baseUrl` configured the plugin stays inert and logs a warning; it never
blocks gateway startup or the chat loop (capture is fire-and-forget, recall
failures degrade to no injection).

## Quick start (library use)

```ts
import { createMemoryHooks } from "@agent-db/openclaw-memory";

const hooks = createMemoryHooks({
  baseUrl: process.env.AGENTDB_BASE_URL,
  pairingToken: process.env.AGENTDB_PAIRING_TOKEN, // single-use; first run only
});

// In the chat loop:
const context = await hooks.beforePrompt(userMessage); // "" when no relevant memory
await hooks.afterMessage({ text: userMessage, sender: "user" });
```

Credentials persist in `~/.openclaw/agentdb/credentials.json` after the first
pairing, so restarts never re-pair. Writes queue to
`~/.openclaw/agentdb/queue.jsonl` when the host is unreachable and replay on the
next `flush()` (the hooks adapter drains opportunistically).

## Configuration

Explicit config wins; environment variables are the fallback:

| Config         | Env                        | Default               |
| -------------- | -------------------------- | --------------------- |
| `baseUrl`      | `AGENTDB_BASE_URL`         | — (required)          |
| `pairingToken` | `AGENTDB_PAIRING_TOKEN`    | —                     |
| `accessToken`  | `AGENTDB_ACCESS_TOKEN`     | —                     |
| `refreshToken` | `AGENTDB_REFRESH_TOKEN`    | —                     |
| `apikey`       | `AGENTDB_WORKSPACE_APIKEY` | — (Shared domain)     |
| `domain`       | `AGENTDB_DOMAIN`           | `Private`             |
| `stateDir`     | `AGENTDB_STATE_DIR`        | `~/.openclaw/agentdb` |
| `recallLimit`  | —                          | `5`                   |

## Tests

Integration tests run against a live local stack and skip when it's down:

```bash
# from the repo root: node scripts/start.js all   (services on 3001–3003)
cd packages/openclaw-memory
npm install
npm test
```

The suite provisions a throwaway identity over the OTP dev echo (non-production
servers only), mints an Agent org + pairing token, then proves pair → remember →
semantic recall → capture → offline queue → flush.

## License

MIT — see [LICENSE](./LICENSE). Depends only on the (also MIT,
zero-runtime-dependency) [`@agent-db/client`](../agentdb/) client.
