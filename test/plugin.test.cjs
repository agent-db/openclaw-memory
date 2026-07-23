/**
 * Unit test for the OpenClaw gateway entry (src/plugin.ts) — no live
 * AgentDB stack needed. A local mock action server plays AgentDB and a
 * fake plugin api records hook registrations. Recall is delivered through
 * the mutating `agent:bootstrap` hook (bootstrapFiles), mirroring the
 * gateway's turn-prepare flow.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Unexpiring fake JWT so Identity uses the configured accessToken as-is. */
function fakeJwt() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 86400;
  return `${b64({ alg: "none" })}.${b64({ exp })}.sig`;
}

/** Mock AgentDB: records action bodies, answers SearchAction with one memory. */
function startMockServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      received.push(body);
      const isSearch = body["@type"] === "SearchAction";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          isSearch
            ? {
                "@type": "SearchAction",
                result: {
                  "@type": "ItemList",
                  itemListElement: [
                    {
                      item: {
                        "@type": "CreativeWork",
                        name: "Deploy freeze",
                        text: "the deploy freeze ends Friday",
                      },
                    },
                  ],
                },
              }
            : { "@type": "CreateAction", success: true }
        )
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        received,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

/** Fake OpenClawPluginApi capturing hook registrations. */
function fakeApi(pluginConfig) {
  const hooks = new Map();
  const warnings = [];
  return {
    api: {
      id: "agentdb-memory",
      name: "AgentDB Memory",
      pluginConfig,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(String(msg)),
        error: () => {},
        debug: () => {},
      },
      registerHook(events, handler, opts) {
        // The gateway registry rejects hooks without a unique opts.name.
        if (!opts || typeof opts.name !== "string" || !opts.name.trim()) {
          throw new Error("hook registration missing name");
        }
        for (const e of [].concat(events)) hooks.set(e, handler);
      },
    },
    hooks,
    warnings,
  };
}

function hookEvent(type, action, context) {
  return {
    type,
    action,
    sessionKey: "session-1",
    context,
    timestamp: new Date(),
    messages: [],
  };
}

function receivedEvent(context) {
  return hookEvent("message", "received", context);
}

test("gateway entry", async (t) => {
  const { default: plugin } = await import("../dist/plugin.js");
  const { registerAgentDBMemory } = await import("../dist/plugin.js");

  await t.test("definePluginEntry shape", () => {
    assert.strictEqual(plugin.id, "agentdb-memory");
    assert.strictEqual(typeof plugin.register, "function");
  });

  await t.test("stays inert when unconfigured", () => {
    const saved = process.env.AGENTDB_BASE_URL;
    delete process.env.AGENTDB_BASE_URL;
    try {
      const { api, hooks, warnings } = fakeApi(undefined);
      registerAgentDBMemory(api);
      assert.strictEqual(hooks.size, 0, "no hooks registered");
      assert.ok(
        warnings.some((w) => w.includes("staying inert")),
        `warned about missing config: ${warnings}`
      );
    } finally {
      if (saved !== undefined) process.env.AGENTDB_BASE_URL = saved;
    }
  });

  await t.test(
    "configured: capture + recall injection round-trip",
    async () => {
      const { server, received, baseUrl } = await startMockServer();
      const stateDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "agentdb-plugin-")
      );
      try {
        const { api, hooks } = fakeApi({
          baseUrl,
          accessToken: fakeJwt(),
          stateDir,
        });
        registerAgentDBMemory(api);
        assert.ok(hooks.has("message:received"), "message:received registered");
        assert.ok(hooks.has("agent:bootstrap"), "agent:bootstrap registered");
        assert.ok(hooks.has("message:sent"), "message:sent registered");

        await hooks.get("message:received")(
          receivedEvent({
            from: "emma",
            content: "when does the deploy freeze end?",
            channelId: "whatsapp",
            messageId: "msg-42",
          })
        );
        // Fire-and-forget capture settles on the same mock server.
        await new Promise((r) => setTimeout(r, 100));

        // Turn prepare: the bootstrap hook injects recalled memories as a
        // synthetic context file.
        const bootstrapCtx = { bootstrapFiles: [] };
        await hooks.get("agent:bootstrap")(
          hookEvent("agent", "bootstrap", bootstrapCtx)
        );
        assert.strictEqual(
          bootstrapCtx.bootstrapFiles.length,
          1,
          "one recall context file"
        );
        const recallFile = bootstrapCtx.bootstrapFiles[0];
        assert.strictEqual(recallFile.path, "AGENTDB_MEMORY.md");
        assert.match(recallFile.content, /Relevant memories from AgentDB/);
        assert.match(recallFile.content, /deploy freeze ends Friday/);

        // The pending query is consumed: a heartbeat turn with no fresh
        // inbound message injects nothing.
        const heartbeatCtx = { bootstrapFiles: [] };
        await hooks.get("agent:bootstrap")(
          hookEvent("agent", "bootstrap", heartbeatCtx)
        );
        assert.strictEqual(
          heartbeatCtx.bootstrapFiles.length,
          0,
          "no stale recall on heartbeat turn"
        );

        const captures = received.filter((b) => b["@type"] === "CreateAction");
        assert.strictEqual(captures.length, 1, "user message captured");
        assert.strictEqual(
          captures[0].object.text,
          "when does the deploy freeze end?"
        );
        assert.strictEqual(captures[0].object.sender.name, "emma");

        // Assistant reply capture.
        await hooks.get("message:sent")(
          receivedEvent({
            to: "emma",
            content: "Friday at noon.",
            channelId: "whatsapp",
            success: true,
          })
        );
        await new Promise((r) => setTimeout(r, 100));
        const afterSent = received.filter((b) => b["@type"] === "CreateAction");
        assert.strictEqual(afterSent.length, 2, "assistant reply captured");
        assert.strictEqual(afterSent[1].object.sender.name, "agent");

        // Failed sends are not captured.
        await hooks.get("message:sent")(
          receivedEvent({ to: "emma", content: "dropped", success: false })
        );
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(
          received.filter((b) => b["@type"] === "CreateAction").length,
          2,
          "failed send skipped"
        );
      } finally {
        server.close();
      }
    }
  );
});
