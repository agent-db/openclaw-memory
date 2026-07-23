/**
 * Offline write queue. When the AgentDB host is unreachable, memory writes
 * append to a JSONL file instead of failing the chat loop; `flush()`
 * replays them when connectivity returns. Reads never queue — recall just
 * degrades to empty.
 */

import fs from "node:fs";
import path from "node:path";

export class OfflineQueue {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "queue.jsonl");
  }

  enqueue(body: unknown): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(body) + "\n", { mode: 0o600 });
  }

  size(): number {
    return this.readAll().length;
  }

  /**
   * Replay queued bodies through `post`. Bodies that still fail with a
   * network error stay queued (preserving order); bodies the server
   * rejects (4xx) are dropped — replaying them can never succeed.
   */
  async flush(post: (body: unknown) => Promise<number>): Promise<{
    sent: number;
    dropped: number;
    remaining: number;
  }> {
    const pending = this.readAll();
    if (pending.length === 0) return { sent: 0, dropped: 0, remaining: 0 };
    const kept: unknown[] = [];
    let sent = 0;
    let dropped = 0;
    for (const body of pending) {
      let status = 0;
      try {
        status = await post(body);
      } catch {
        status = 0;
      }
      if (status === 0 || status >= 500) kept.push(body);
      else if (status >= 400) dropped++;
      else sent++;
    }
    fs.writeFileSync(
      this.file,
      kept.map((b) => JSON.stringify(b) + "\n").join(""),
      { mode: 0o600 }
    );
    return { sent, dropped, remaining: kept.length };
  }

  private readAll(): unknown[] {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
