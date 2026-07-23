# Changelog

All notable changes to `@agent-db/openclaw-memory` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Recall is now injected through the mutating `agent:bootstrap` internal hook as
  a synthetic `AGENTDB_MEMORY.md` bootstrap context file, replacing
  `enqueueNextTurnInjection`. OpenClaw's plugin API lifecycle guard (2026.7.x,
  including 2026.7.2-beta.3) only keeps `emitAgentEvent`,
  `sendSessionAttachment`, `scheduleSessionTurn`, and
  `unscheduleSessionTurnsByTag` callable after registration, so the injection
  call silently returned `undefined` from message hooks. Verified live: the
  model quotes the injected block verbatim from its context.
- `message:received` now records the message as the session's pending recall
  query (LRU-capped at 256 sessions); the query is consumed at the next
  bootstrap so heartbeat/scheduled turns don't re-inject stale recall.
- `beforePrompt` over-fetches recall and filters out echoes of the query itself
  — the just-captured message always outranked the memories the user actually
  wanted.

## [0.1.0] - 2026-07-23

### Added

- Initial release: OpenClaw gateway plugin giving agents long-term, cross-device
  memory backed by AgentDB.
- `AgentDBMemory` engine: conversation capture as Schema.org `Message` entities,
  semantic recall (`similarTo` with `like` fallback), offline write queue with
  replay, pairing-token identity with automatic token rotation.
- `createMemoryHooks` adapter: `beforePrompt` (recall + context injection) and
  `afterMessage` (fire-and-forget capture).
- OpenClaw gateway entry (`dist/plugin.js`, declared via
  `package.json#openclaw.extensions`): registers `message:received` (capture +
  recall queued as a next-turn context injection, deduped per provider message
  id) and `message:sent` (assistant-side capture) internal hooks; stays inert
  with a logged warning when unconfigured.
- Bundled ClawHub skills: `agentdb` (pairing + full action API over one
  endpoint) and `agentdb-fleet` (shared-workspace task-queue pattern for
  multi-agent fleets).
- Plugin manifest with typed `configSchema` (`baseUrl`, `pairingToken`,
  `apikey`, `domain`, `stateDir`, `recallLimit`).
