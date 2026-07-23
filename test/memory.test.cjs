/**
 * Integration test against a live AgentDB stack (scripts/start.js all).
 * Skips cleanly when the stack is down. Provisions a throwaway identity
 * over the OTP dev echo (non-production servers only), mints an Agent org
 * + pairing token, then exercises the plugin engine end-to-end:
 * pair → remember → recall (semantic w/ like fallback) → capture →
 * offline queue → flush.
 */

const { test, before } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE = (process.env.AGENTDB_BASE_URL || "http://localhost:3003").replace(
  /\/$/,
  ""
);
const ACTION = `${BASE}/api/action`;
const suffix = Math.random().toString(36).slice(2, 8);

let up = false;
let pairingToken = null;
let stateDir = null;

async function post(body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(ACTION, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Fresh admin JWT via the email+OTP LoginAction dev echo. */
async function mintAdmin() {
  const email = `openclaw-memory-${suffix}@example.com`;
  const login = (code) => ({
    "@type": "LoginAction",
    object: { "@type": "Person", email },
    ...(code
      ? {
          instrument: [{ "@type": "PropertyValue", name: "code", value: code }],
        }
      : {}),
  });
  const requested = await post(login());
  const instruments = Array.isArray(requested.data?.instrument)
    ? requested.data.instrument
    : [requested.data?.instrument];
  const code = instruments.find((p) => p?.name === "code")?.value;
  if (!code) throw new Error("OTP dev echo off — is this a production server?");
  const verified = await post(login(String(code)));
  const token = verified.data?.result?.text;
  if (!token) throw new Error("OTP verify failed");
  return token;
}

function entityId(data) {
  const r = data?.result;
  return r?.["@id"] ?? r?.identifier ?? null;
}

before(async () => {
  try {
    const health = await fetch(`${BASE}/api/data/health`);
    up = health.status === 200;
  } catch {
    up = false;
  }
  if (!up) return;

  const adminToken = await mintAdmin();
  const org = await post(
    {
      "@type": "CreateAction",
      object: {
        "@type": "Organization",
        additionalType: "Agent",
        name: `openclaw-memory-agent-${suffix}`,
      },
    },
    adminToken
  );
  const agentOrgId = entityId(org.data);
  assert.ok(agentOrgId, `agent org created: ${JSON.stringify(org.data)}`);

  const regen = await post(
    {
      "@type": "UpdateAction",
      object: {
        "@type": "Organization",
        "@id": agentOrgId,
        additionalType: "Agent",
      },
      instrument: {
        "@type": "PropertyValue",
        name: "regeneratePairingToken",
        value: true,
      },
    },
    adminToken
  );
  // The token rides in result.identifier as a PropertyValue entry.
  const identifiers = [].concat(regen.data?.result?.identifier ?? []);
  pairingToken =
    regen.data?.pairingToken ??
    identifiers.find((p) => p?.name === "pairingToken")?.value ??
    null;
  assert.ok(
    pairingToken,
    `pairing token issued: ${JSON.stringify(regen.data)}`
  );

  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdb-openclaw-"));
});

test("openclaw-memory engine end-to-end", async (t) => {
  if (!up) {
    t.skip(
      `AgentDB stack not reachable at ${BASE} — start with scripts/start.js all`
    );
    return;
  }
  const { AgentDBMemory, createMemoryHooks } = await import("../dist/index.js");

  const memory = new AgentDBMemory({
    baseUrl: BASE,
    pairingToken,
    stateDir,
    domain: "Private",
  });

  const fact = `the deploy freeze ends on Friday at noon (${suffix})`;

  await t.test("pairs and persists credentials on first write", async () => {
    const res = await memory.remember(fact, {
      name: "Deploy freeze",
      topics: ["release", "schedule"],
    });
    assert.ok(!res.queued, "write should not queue while the stack is up");
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    assert.notStrictEqual(res.data?.success, false, JSON.stringify(res.data));
    assert.ok(
      fs.existsSync(path.join(stateDir, "credentials.json")),
      "credentials persisted"
    );
  });

  await t.test("recalls the memory (semantic, like fallback)", async () => {
    let hit = null;
    for (let attempt = 0; attempt < 20 && !hit; attempt++) {
      const items = await memory.recall("when does the deploy freeze end");
      hit = items.find((m) => (m.text || "").includes(suffix));
      if (!hit) await new Promise((r) => setTimeout(r, 1500));
    }
    assert.ok(hit, "stored memory came back for a topically-related query");
    const block = memory.renderRecall([hit]);
    assert.match(block, /Relevant memories from AgentDB/);
    assert.ok(block.includes(suffix));
  });

  await t.test("captures a conversation message", async () => {
    const res = await memory.captureMessage({
      text: `ok let's plan the release retro after the freeze (${suffix})`,
      sender: "emma",
      channel: "whatsapp",
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
  });

  await t.test("queues writes offline and flushes on reconnect", async () => {
    // Same stateDir (reuses persisted credentials + queue file), dead host.
    const offline = new AgentDBMemory({
      baseUrl: "http://127.0.0.1:59999",
      stateDir,
      domain: "Private",
    });
    const res = await offline.remember(`offline note (${suffix})`);
    assert.strictEqual(res.queued, true, "network failure should queue");
    assert.strictEqual(memory.queuedWrites(), 1);

    const flushed = await memory.flush();
    assert.strictEqual(flushed.sent, 1, JSON.stringify(flushed));
    assert.strictEqual(flushed.remaining, 0);
    assert.strictEqual(memory.queuedWrites(), 0);
  });

  await t.test(
    "hooks adapter: beforePrompt injects, afterMessage captures",
    async () => {
      const hooks = createMemoryHooks({
        baseUrl: BASE,
        stateDir,
        domain: "Private",
      });
      const block = await hooks.beforePrompt("deploy freeze schedule");
      assert.ok(
        block.includes(suffix),
        `beforePrompt found the memory: ${block}`
      );
      await hooks.afterMessage({ text: `noted (${suffix})`, sender: "user" });
    }
  );
});
