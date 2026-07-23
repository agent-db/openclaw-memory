/**
 * OpenClaw gateway entry.
 *
 * Wires the framework-free memory engine into the gateway's plugin API:
 *
 *   - `message:received` — capture the user message (fire-and-forget) and
 *     recall relevant memories, queueing them as a next-turn context
 *     injection so the agent sees them when the turn is prepared;
 *   - `message:sent` — capture the assistant's reply so both sides of the
 *     exchange are recallable.
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

  api.registerHook("message:received", async (event) => {
    const ctx = event.context as ReceivedContext;
    const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
    if (!text) return;

    // Capture must never block or fail the chat loop.
    void hooks
      .afterMessage({ text, sender: ctx.from, channel: ctx.channelId })
      .catch((err) => warn(api.logger, "capture failed", err));

    try {
      const block = await hooks.beforePrompt(text);
      if (!block) return;
      await api.session.workflow.enqueueNextTurnInjection({
        sessionKey: event.sessionKey,
        text: block,
        // Dedupe per provider message so redeliveries don't stack blocks.
        ...(ctx.messageId ? { idempotencyKey: ctx.messageId } : {}),
      });
    } catch (err) {
      warn(api.logger, "recall failed", err);
    }
  });

  api.registerHook("message:sent", async (event) => {
    const ctx = event.context as SentContext;
    if (ctx.success === false) return;
    const text = typeof ctx.content === "string" ? ctx.content.trim() : "";
    if (!text) return;
    void hooks
      .afterMessage({ text, sender: "agent", channel: ctx.channelId })
      .catch((err) => warn(api.logger, "capture failed", err));
  });
}

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "AgentDB Memory",
  description:
    "Long-term, cross-device agent memory backed by AgentDB — Schema.org entities with semantic recall.",
  register: registerAgentDBMemory,
});

export default plugin;
