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

## Data Collector sync (optional)

Finished jobs can be copied to your own Data Collector. LeadCollector does
this itself, with its own key, so it does not need EvoMesh running. It is
off unless both of these are set in the operator's environment (never in
the repository):

| Variable | Meaning |
| --- | --- |
| `LEADCOLLECTOR_DC_URL` | e.g. `https://data.example.com/api/v1` (https only) |
| `LEADCOLLECTOR_DC_API_KEY` | a write-only ingest key for the collections below |
| `LEADCOLLECTOR_DC_COLLECTION_BUSINESS` | collection id for `business` records |
| `LEADCOLLECTOR_DC_COLLECTION_CONTACT` | collection id for `contact` records |
| `LEADCOLLECTOR_DC_COLLECTION_OBSERVATION` | collection id for `source_observation` records |
| `LEADCOLLECTOR_DC_COLLECTION_RUN` | collection id for `agent_run` (job) records |
| `LEADCOLLECTOR_DC_INTERVAL_SECONDS` | sync interval, default 30 |

Each finished job becomes contract-v1 events in a `dc_outbox` table in the
same SQLite file, inside one transaction with the job's exported mark.
Delivery is at-least-once with an `Idempotency-Key` per event. Network
failures, 429 and 5xx responses are retried with backoff. A rejected key
keeps the events. Any other 4xx becomes a dead letter in `dc_outbox`. The
local database stays the working store either way.
