# Milestone 3 implementation plan

Baseline is LeadCollector 28505a8 and EvoMesh 19f801a. LeadCollector has an in-memory job map, a Nest/Fastify API and an MCP stdio entrypoint. The MV3 worker keeps the active tab in memory, loses it on suspension and closes it even if submission fails. The content script already supplies provider IDs, listing URLs and map fields. EvoMesh already supports agent templates, scoped MCP servers, and explicit automation-profile browser grants.

| Phase | Files and approach | Acceptance |
| --- | --- | --- |
| 1 | `apps/api/src/main.ts`, `modules/jobs/{jobs.service,jobs.controller,jobs.dto,jobs.types,collector.config,migrations}.ts` | Loopback and role tokens, atomic claim, bounded queue, lease renewal, replay, cancellation, expiry and SQLite reopen |
| 2 | `chrome-extension/lib/{background,collection-worker,api}.ts`, popup settings, content app, shared event/config files | Alarm wakes, persisted browser-session assignment, durable completion retry, tab/document binding, challenge and cleanup fixtures |
| 3 | `modules/jobs/{leads,migrations,jobs.service}.ts` | Provider identity, conservative address/domain fallback, stable job snapshots, bounded search and field lineage |
| 4 | `modules/app/{app.service,website-fetch}.ts`, existing contact extractors, enrichment queue | Public DNS pinning per request, limited redirects and bodies, exact source URLs, partial results |
| 5 | `apps/api/mcp-server.mjs` and `modules/jobs/exports.ts` | MCP SDK round trip, structured errors, result pagination, CSV/JSON files and checksum |
| 6 | EvoMesh `agent-templates/lead-researcher`, companion contract test and setup guide | Agent-limited MCP configuration and automation grant, with separate Chrome/bridge/worker/DB checks |
| 7–9 | `scripts/Start-LeadCollector.ps1`, docs, API/extension/MCP tests, Windows/Linux CI | Local installation, opt-in fixture smoke, versioned audit evidence contract |

Use Node's bundled SQLite on Node 22.13 or newer to avoid a separate Windows native build. Retain the API's `done` and `error` names. Collection and enrichment are distinct phases of one job, with listing data committed before optional crawling. Preserve the upstream map parser and manual export. Configure an export root explicitly for EvoMesh and have the backend generate safe artifact names. Keep report generation outside this milestone.

## Baseline evidence

| Check | Original HEAD |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed with pinned pnpm 9.4 and the optional Puppeteer download skipped |
| `pnpm build:api` | Passed |
| `pnpm build:extension` | Returned success with zero tasks |
| `pnpm type-check` and `pnpm test` | Failed before the API tasks because pnpm found an invalid nested API workspace |
| API check-only ESLint | Blocked by ESLint 9 requiring flat config. The repo has only `.eslintrc.js` |
| EvoMesh `uv sync --locked` and `uv run pytest -q` | Install passed. 1,474 tests passed and 10 skipped. The eight headless browser fixtures failed or errored because Chromium timed out launching in this environment |

The implementation uses the root workspace and targets all extension build
packages directly. Corepack's registry request was blocked in this
environment. The same pinned pnpm 9.4.0 tarball was fetched with curl and its
binary was used for the reported checks.
