/**
 * Plugin configuration — resolved from an explicit object (OpenClaw's
 * `skills.entries.*.config` bag / plugin config) with environment-variable
 * fallbacks, so both the plugin runtime and a bare skill invocation share
 * one contract.
 */

import os from "node:os";
import path from "node:path";

export type MemoryDomain = "Private" | "Shared" | "Internal" | "Public";

export interface AgentDBMemoryConfig {
  /** REST base URL, e.g. https://api.agentdb.example — no trailing slash. */
  baseUrl?: string;
  /** One-time pairing token (preferred bootstrap: single-use, scoped). */
  pairingToken?: string;
  /** Pre-minted tokens (alternative to pairingToken). */
  accessToken?: string;
  refreshToken?: string;
  /** Workspace api key — required for Shared-domain fleet memory. */
  apikey?: string;
  /** Data domain memories are written to. Default Private. */
  domain?: MemoryDomain;
  /** Directory for persisted credentials + the offline queue. */
  stateDir?: string;
  /** Max entities returned by recall. Default 5. */
  recallLimit?: number;
}

export interface ResolvedConfig {
  baseUrl: string;
  pairingToken?: string;
  accessToken?: string;
  refreshToken?: string;
  apikey?: string;
  domain: MemoryDomain;
  stateDir: string;
  recallLimit: number;
}

const DOMAINS: MemoryDomain[] = ["Private", "Shared", "Internal", "Public"];

export function resolveConfig(
  config: AgentDBMemoryConfig = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const baseUrl = (config.baseUrl ?? env.AGENTDB_BASE_URL ?? "").replace(
    /\/$/,
    ""
  );
  if (!baseUrl) {
    throw new Error(
      "AgentDB memory: no baseUrl — set config.baseUrl or AGENTDB_BASE_URL"
    );
  }
  const rawDomain = config.domain ?? env.AGENTDB_DOMAIN ?? "Private";
  const domain = DOMAINS.find(
    (d) => d.toLowerCase() === String(rawDomain).toLowerCase()
  );
  if (!domain) {
    throw new Error(
      `AgentDB memory: invalid domain "${rawDomain}" (use ${DOMAINS.join(
        ", "
      )})`
    );
  }
  return {
    baseUrl,
    pairingToken: config.pairingToken ?? env.AGENTDB_PAIRING_TOKEN,
    accessToken: config.accessToken ?? env.AGENTDB_ACCESS_TOKEN,
    refreshToken: config.refreshToken ?? env.AGENTDB_REFRESH_TOKEN,
    apikey: config.apikey ?? env.AGENTDB_WORKSPACE_APIKEY,
    domain,
    stateDir:
      config.stateDir ??
      env.AGENTDB_STATE_DIR ??
      path.join(os.homedir(), ".openclaw", "agentdb"),
    recallLimit: config.recallLimit ?? 5,
  };
}
