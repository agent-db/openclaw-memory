/**
 * The memory engine. Everything is Schema.org JSON-LD over the unified
 * action endpoint (`POST /api/action`):
 *
 *   - a memory is a `CreativeWork` with `additionalType: "Memory"` —
 *     `text` carries the content, `keywords` the topics;
 *   - a captured chat message is a `Message` with `text` + `sender`;
 *   - recall is a `SearchAction` with the semantic `similarTo`
 *     measurementMethod, falling back to substring `like` while
 *     embeddings index asynchronously.
 *
 * Writes that fail with a network error go to the offline queue; recall
 * degrades to an empty result rather than blocking the chat loop.
 */

import { extractItems } from "agentdb";

import { Identity } from "./auth.js";
import {
  AgentDBMemoryConfig,
  resolveConfig,
  ResolvedConfig,
} from "./config.js";
import { OfflineQueue } from "./queue.js";

export interface MemoryEntity {
  id?: string;
  identifier?: string;
  name?: string;
  text?: string;
  keywords?: string;
  type: string;
}

export interface ActionOutcome {
  status: number;
  data: any;
  queued?: boolean;
}

const ACTION = "/api/action";

export class AgentDBMemory {
  readonly config: ResolvedConfig;
  private readonly identity: Identity;
  private readonly queue: OfflineQueue;

  constructor(config: AgentDBMemoryConfig = {}) {
    this.config = resolveConfig(config);
    this.identity = new Identity(this.config);
    this.queue = new OfflineQueue(this.config.stateDir);
  }

  // ── Writes ────────────────────────────────────────────────────────────

  /** Persist an explicit memory ("remember that …"). */
  async remember(
    text: string,
    opts: { name?: string; topics?: string[] } = {}
  ): Promise<ActionOutcome> {
    return this.write({
      "@type": "CreateAction",
      object: {
        "@type": "CreativeWork",
        additionalType: "Memory",
        ...(opts.name ? { name: opts.name } : {}),
        text,
        ...(opts.topics?.length ? { keywords: opts.topics.join(", ") } : {}),
      },
    });
  }

  /** Capture a conversation message for later recall. */
  async captureMessage(msg: {
    text: string;
    sender?: string;
    channel?: string;
  }): Promise<ActionOutcome> {
    return this.write({
      "@type": "CreateAction",
      object: {
        "@type": "Message",
        additionalType: "CapturedMessage",
        text: msg.text,
        ...(msg.sender
          ? { sender: { "@type": "Person", name: msg.sender } }
          : {}),
        ...(msg.channel ? { keywords: msg.channel } : {}),
      },
    });
  }

  // ── Recall ────────────────────────────────────────────────────────────

  /**
   * Semantic recall over stored memories; falls back to substring match
   * (embeddings index asynchronously, and very short queries match better
   * literally). Network failure returns [] — recall never throws into the
   * chat loop.
   */
  async recall(
    query: string,
    opts: { limit?: number; type?: string } = {}
  ): Promise<MemoryEntity[]> {
    const limit = opts.limit ?? this.config.recallLimit;
    const type = opts.type ?? "CreativeWork";
    try {
      const semantic = await this.search(type, query, "similarTo", limit);
      if (semantic.length > 0) return semantic;
      return await this.search(type, query, "like", limit);
    } catch {
      return [];
    }
  }

  /** Render recalled memories as a compact context block for the prompt. */
  renderRecall(items: MemoryEntity[]): string {
    if (items.length === 0) return "";
    const lines = items.map((m) => {
      const label = m.name ? `${m.name}: ` : "";
      const topics = m.keywords ? ` [${m.keywords}]` : "";
      return `- ${label}${m.text ?? ""}${topics}`;
    });
    return `Relevant memories from AgentDB:\n${lines.join("\n")}`;
  }

  // ── Maintenance ───────────────────────────────────────────────────────

  /** Replay offline-queued writes. Safe to call on any reconnect signal. */
  async flush(): Promise<{ sent: number; dropped: number; remaining: number }> {
    return this.queue.flush(async (body) => {
      const res = await this.post(body);
      return res.status;
    });
  }

  /** Queued write count (diagnostics). */
  queuedWrites(): number {
    return this.queue.size();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async search(
    type: string,
    query: string,
    method: "similarTo" | "like",
    limit: number
  ): Promise<MemoryEntity[]> {
    const res = await this.post({
      "@type": "SearchAction",
      object: {
        "@type": "PropertyValue",
        identifier: { "@type": "PropertyValue", value: type },
        valueReference: [
          {
            "@type": "PropertyValue",
            name: "text",
            value: query,
            measurementMethod: [{ "@type": "DefinedTerm", name: method }],
          },
        ],
      },
      instrument: [{ "@type": "PropertyValue", name: "limit", value: limit }],
    });
    if (res.status !== 200) return [];
    return extractItems(res.data)
      .filter(Boolean)
      .map((e: any) => ({
        id: e["@id"],
        identifier: e.identifier,
        name: e.name,
        text: e.text,
        keywords: e.keywords,
        type: e["@type"],
      }));
  }

  private async write(body: Record<string, unknown>): Promise<ActionOutcome> {
    try {
      const res = await this.post(body);
      if (res.status === 0) throw new Error("network");
      return res;
    } catch {
      this.queue.enqueue(body);
      return { status: 0, data: null, queued: true };
    }
  }

  /** POST one action with the domain envelope; one rotate-retry on 401. */
  private async post(body: unknown): Promise<ActionOutcome> {
    const envelope = {
      ...(body as Record<string, unknown>),
      location: { "@type": "VirtualLocation", name: this.config.domain },
    };
    let token = await this.identity.ensureToken();
    let res = await this.dispatch(envelope, token);
    if (res.status === 401) {
      token = await this.identity.rotate();
      res = await this.dispatch(envelope, token);
    }
    return res;
  }

  private async dispatch(
    envelope: unknown,
    token: string
  ): Promise<ActionOutcome> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (this.config.apikey) headers.apikey = this.config.apikey;
    const res = await fetch(`${this.config.baseUrl}${ACTION}`, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
}
