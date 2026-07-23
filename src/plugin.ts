/**
 * OpenClaw gateway entry.
 *
 * Wires the framework-free memory engine into the gateway's plugin API:
 *
 *   - `message:received` — capture the user message (fire-and-forget) and
 *     remember it as the session's pending recall query;
 *   - `agent:bootstrap` — when the turn is prepared, recall memories for
 *     the pending query and append them as a synthetic bootstrap context
 *     file so the agent sees them in the same turn;
 *   - `message:sent` — capture the assistant's reply so both sides of the
 *     exchange are recallable.
 *
 * Recall is injected through `agent:bootstrap` (a mutating hook awaited at
 * every turn preparation) rather than `enqueueNextTurnInjection`: the
 * plugin API lifecycle guard in OpenClaw 2026.7.x only keeps four methods
 * callable after registration (`emitAgentEvent`, `sendSessionAttachment`,
 * `scheduleSessionTurn`, `unscheduleSessionTurnsByTag`), so calling
 * `enqueueNextTurnInjection` from a message hook silently no-ops.
 *
 * Config comes from the plugin config bag (see `configSchema` in
 * `openclaw.plugin.json`) with env-var fallbacks handled by
 * `resolveConfig`. When no baseUrl is configured the plugin logs a warning
 * and stays inert instead of failing gateway startup.
 */

import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import type { AgentDBMemoryConfig } from "./config.js";
import type { MemoryHooks } from "./index.js";
import { createMemoryHooks } from "./index.js";

const PLUGIN_ID = "agentdb-memory";

/**
 * Synthetic path label for the injected recall context file. Relative, so
 * the gateway resolves it under the workspace root and renders the section
 * header as `## <workspace>/AGENTDB_MEMORY.md`; the file never exists on
 * disk — content is supplied inline.
 */
export const RECALL_BOOTSTRAP_PATH = "AGENTDB_MEMORY.md";

/** Cap on tracked sessions so long-lived gateways don't grow unbounded. */
const MAX_TRACKED_SESSIONS = 256;

/** Context shape of `message:received` internal hook events. */
interface ReceivedContext {
  from?: string;
  content?: string;
  channelId?: string;
  messageId?: string;
}

/** Context shape of `message:sent` internal hook events. */
interface SentContext {
  to?: string;
  content?: string;
  channelId?: string;
  success?: boolean;
}

/** Context shape of `agent:bootstrap` internal hook events. */
interface BootstrapContext {
  bootstrapFiles?: Array<{
    name?: string;
    path?: string;
    content?: string;
  }>;
}

function warn(logger: PluginLogger, what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn(`${PLUGIN_ID}: ${what} — ${detail}`);
}

export function registerAgentDBMemory(api: OpenClawPluginApi): void {
  let hooks: MemoryHooks;
  try {
    hooks = createMemoryHooks((api.pluginConfig ?? {}) as AgentDBMemoryConfig);
  } catch (err) {
    warn(api.logger, "not configured, staying inert", err);
    return;
  }

  // Latest inbound message per session — the pending recall query consumed
  // by the bootstrap hook when the turn is prepared. Insertion-ordered Map
  // doubles as a cheap LRU.
  const pendingRecall = new Map<string, string>();
  const rememberQuery = (sessionKey: string, text: string) => {
    pendingRecall.delete(sessionKey);
    pendingRecall.set(sessionKey, text);
    while (pendingRecall.size > MAX_TRACKED_SESSIONS) {
      const oldest = pendingRecall.keys().next().value;
      if (oldest === undefined) break;
      pendingRecall.delete(oldest);
    }
  };

  api.registerHook(
    "message:received",
    async (event) => {
      const ctx = event.context as ReceivedContext;
      const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
      if (!text) return;

      if (typeof event.sessionKey === "string" && event.sessionKey) {
        rememberQuery(event.sessionKey, text);
      }

      // Capture must never block or fail the chat loop.
      await hooks
        .afterMessage({ text, sender: ctx.from, channel: ctx.channelId })
        .catch((err) => warn(api.logger, "capture failed", err));
    },
    {
      name: "agentdb-memory-capture-received",
      description: "Capture inbound messages to AgentDB memory.",
    }
  );

  api.registerHook(
    "agent:bootstrap",
    async (event) => {
      const sessionKey =
        typeof event.sessionKey === "string" ? event.sessionKey : "";
      const query = sessionKey ? pendingRecall.get(sessionKey) : undefined;
      if (!query) return;
      // Consume the query so heartbeat/scheduled turns without a fresh
      // inbound message don't re-inject stale recall.
      pendingRecall.delete(sessionKey);

      let block: string;
      try {
        block = await hooks.beforePrompt(query);
      } catch (err) {
        warn(api.logger, "recall failed", err);
        return;
      }
      if (!block) return;

      const ctx = event.context as BootstrapContext;
      const files = Array.isArray(ctx.bootstrapFiles)
        ? ctx.bootstrapFiles
        : (ctx.bootstrapFiles = []);
      // Never stack two recall files in one turn.
      const existing = files.findIndex(
        (f) => f?.path === RECALL_BOOTSTRAP_PATH
      );
      const file = {
        name: "AGENTDB_MEMORY.md",
        path: RECALL_BOOTSTRAP_PATH,
        content: block,
      };
      if (existing >= 0) files[existing] = file;
      else files.push(file);
    },
    {
      name: "agentdb-memory-recall",
      description:
        "Inject recalled AgentDB memories into agent turn context at bootstrap.",
    }
  );

  api.registerHook(
    "message:sent",
    async (event) => {
      const ctx = event.context as SentContext;
      if (ctx.success === false) return;
      const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
      if (!text) return;
      void hooks
        .afterMessage({ text, sender: "agent", channel: ctx.channelId })
        .catch((err) => warn(api.logger, "capture failed", err));
    },
    {
      name: "agentdb-memory-capture-sent",
      description: "Capture assistant replies to AgentDB memory.",
    }
  );
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "AgentDB Memory",
  description:
    "Long-term, cross-device agent memory backed by AgentDB — Schema.org entities with semantic recall.",
  register: registerAgentDBMemory,
});

export default plugin;
