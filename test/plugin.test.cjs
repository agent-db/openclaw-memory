/**
 * Unit test for the OpenClaw gateway entry (src/plugin.ts) — no live
 * AgentDB stack needed. A local mock action server plays AgentDB and a
 * fake plugin api records hook registrations and next-turn injections.
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

/** Fake OpenClawPluginApi capturing hook + injection traffic. */
function fakeApi(pluginConfig) {
  const hooks = new Map();
  const injections = [];
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
      registerHook(events, handler) {
        for (const e of [].concat(events)) hooks.set(e, handler);
      },
      session: {
        workflow: {
          async enqueueNextTurnInjection(injection) {
            injections.push(injection);
            return {
              enqueued: true,
              id: "inj-1",
              sessionKey: injection.sessionKey,
            };
          },
        },
      },
    },
    hooks,
    injections,
    warnings,
  };
}

function receivedEvent(context) {
  return {
    type: "message",
    action: "received",
    sessionKey: "session-1",
    context,
    timestamp: new Date(),
    messages: [],
  };
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
        const { api, hooks, injections } = fakeApi({
          baseUrl,
          accessToken: fakeJwt(),
          stateDir,
        });
        registerAgentDBMemory(api);
        assert.ok(hooks.has("message:received"), "message:received registered");
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

        assert.strictEqual(injections.length, 1, "one next-turn injection");
        assert.strictEqual(injections[0].sessionKey, "session-1");
        assert.strictEqual(injections[0].idempotencyKey, "msg-42");
        assert.match(injections[0].text, /Relevant memories from AgentDB/);
        assert.match(injections[0].text, /deploy freeze ends Friday/);

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
