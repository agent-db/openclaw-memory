/**
 * Identity lifecycle: pairing-token bootstrap, token persistence, and
 * refresh rotation. Tokens are stored (0600) under the plugin's state dir
 * so a gateway restart never re-pairs — pairing tokens are single-use.
 */

import { pairAgent, rotateAgentToken } from "@agent-db/client/side-apis";
import fs from "node:fs";
import path from "node:path";

import type { ResolvedConfig } from "./config.js";

interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
}

function credentialsPath(stateDir: string): string {
  return path.join(stateDir, "credentials.json");
}

function jwtExpiresSoon(token: string, bufferSeconds = 300): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 < Date.now() + bufferSeconds * 1000;
  } catch {
    return true;
  }
}

export class Identity {
  private creds: StoredCredentials | null = null;

  constructor(private readonly config: ResolvedConfig) {}

  /** Return a live access token, bootstrapping or rotating as needed. */
  async ensureToken(): Promise<string> {
    if (!this.creds) this.creds = this.load();
    if (this.creds && !jwtExpiresSoon(this.creds.accessToken)) {
      return this.creds.accessToken;
    }
    if (this.creds?.refreshToken) {
      const rotated = await rotateAgentToken(
        this.config.baseUrl,
        this.creds.refreshToken
      );
      if (rotated.accessToken) {
        this.persist({
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
        });
        return rotated.accessToken;
      }
    }
    return this.bootstrap();
  }

  /** Force a rotation (used after a 401 on an action). */
  async rotate(): Promise<string> {
    if (!this.creds) this.creds = this.load();
    if (this.creds?.refreshToken) {
      const rotated = await rotateAgentToken(
        this.config.baseUrl,
        this.creds.refreshToken
      );
      if (rotated.accessToken) {
        this.persist({
          accessToken: rotated.accessToken,
          refreshToken: rotated.refreshToken,
        });
        return rotated.accessToken;
      }
    }
    return this.bootstrap();
  }

  private async bootstrap(): Promise<string> {
    if (this.config.accessToken) {
      this.persist({
        accessToken: this.config.accessToken,
        refreshToken: this.config.refreshToken,
      });
      return this.config.accessToken;
    }
    if (this.config.pairingToken) {
      const paired = await pairAgent(
        this.config.baseUrl,
        this.config.pairingToken
      );
      if (!paired.accessToken) {
        throw new Error(
          `AgentDB memory: pairing failed — ${paired.error ?? "no token"}. ` +
            "Pairing tokens are single-use; mint a fresh one if this one was consumed."
        );
      }
      this.persist({
        accessToken: paired.accessToken,
        refreshToken: paired.refreshToken,
      });
      return paired.accessToken;
    }
    throw new Error(
      "AgentDB memory: no credentials — provide a pairingToken (AGENTDB_PAIRING_TOKEN) " +
        "or accessToken/refreshToken, or pre-pair and keep the state dir."
    );
  }

  private load(): StoredCredentials | null {
    try {
      const raw = fs.readFileSync(
        credentialsPath(this.config.stateDir),
        "utf8"
      );
      const parsed = JSON.parse(raw);
      if (typeof parsed.accessToken === "string") return parsed;
    } catch {
      /* first run */
    }
    return null;
  }

  private persist(creds: StoredCredentials): void {
    this.creds = creds;
    fs.mkdirSync(this.config.stateDir, { recursive: true });
    fs.writeFileSync(
      credentialsPath(this.config.stateDir),
      JSON.stringify(creds, null, 2),
      { mode: 0o600 }
    );
  }
}
