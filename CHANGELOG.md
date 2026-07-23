# Changelog

All notable changes to `@agent-db/openclaw-memory` are documented here. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
