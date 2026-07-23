/**
 * @agentdb/openclaw-memory — OpenClaw gateway plugin giving agents
 * long-term, cross-device memory backed by AgentDB.
 *
 * The engine (`AgentDBMemory`) is framework-free; `createMemoryHooks`
 * adapts it to the two integration points a chat gateway needs:
 *
 *   - `beforePrompt(userText)` — recall relevant memories and return a
 *     context block to inject (empty string when nothing relevant);
 *   - `afterMessage(msg)` — capture the exchange (fire-and-forget; writes
 *     queue offline when the host is unreachable).
 *
 * The plugin also ships the `agentdb` and `agentdb-fleet` skills (see
 * `skills/` + `openclaw.plugin.json`) so the agent knows how to drive the
 * full action API beyond automatic capture/recall.
 */

export { Identity } from "./auth.js";
export type {
  AgentDBMemoryConfig,
  MemoryDomain,
  ResolvedConfig,
} from "./config.js";
export { resolveConfig } from "./config.js";
export type { ActionOutcome, MemoryEntity } from "./memory.js";
export { AgentDBMemory } from "./memory.js";
export { OfflineQueue } from "./queue.js";

import type { AgentDBMemoryConfig } from "./config.js";
import { AgentDBMemory } from "./memory.js";

export interface MemoryHooks {
  memory: AgentDBMemory;
  beforePrompt(userText: string): Promise<string>;
  afterMessage(msg: {
    text: string;
    sender?: string;
    channel?: string;
  }): Promise<void>;
}

/** Whitespace/case-insensitive comparison key for echo filtering. */
function textKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function createMemoryHooks(config: AgentDBMemoryConfig): MemoryHooks {
  const memory = new AgentDBMemory(config);
  return {
    memory,
    async beforePrompt(userText: string): Promise<string> {
      const limit = memory.config.recallLimit;
      // Over-fetch, then drop echoes of the query itself: the current
      // message (and repeats of it from other sessions) is captured too,
      // and it always outranks the memories the user actually wants.
      const items = await memory.recall(userText, { limit: limit * 2 + 2 });
      const queryKey = textKey(userText);
      const relevant = items
        .filter((m) => textKey(m.text ?? "") !== queryKey)
        .slice(0, limit);
      return memory.renderRecall(relevant);
    },
    async afterMessage(msg): Promise<void> {
      await memory.captureMessage(msg);
      // Opportunistic queue drain — cheap no-op when the queue is empty.
      if (memory.queuedWrites() > 0) await memory.flush().catch(() => {});
    },
  };
}
