# EvoMesh LeadCollector local API

The NestJS API stores jobs and leads in local SQLite. It provides the
authenticated browser-worker protocol, a bounded public-website contact
pipeline and a stdio MCP server.

From the repository root, install with `pnpm install --frozen-lockfile`
and build with `pnpm build:api`. Use
[Windows setup](../../docs/WINDOWS_SETUP.md) to provision local configuration.
Run `pnpm --filter mapscan_api start` for the built API or `pnpm dev:api`
for watch mode. Both require the local agent and worker credentials.

See [MCP and HTTP](MCP.md), [architecture](../../docs/ARCHITECTURE.md), and
[smoke tests](../../docs/SMOKE_TEST.md).

Docker is optional. The Compose example is for Linux host networking so
the process still listens on host loopback. Supply the two local tokens
through the operator's environment and run `docker compose up --build`
from this directory. The Windows setup uses the native Node process.
