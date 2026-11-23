# LeadCollector API and MCP

Run the [local backend and extension setup](../../docs/WINDOWS_SETUP.md)
first. Register `node <absolute path>/apps/api/mcp-server.mjs` as an MCP
stdio server. It defaults to `http://127.0.0.1:5050` and reads
`BACKEND_URL` and `LEADCOLLECTOR_AGENT_TOKEN` from its environment,
`LEADCOLLECTOR_ENV_FILE`, or the local `.env.agent` beside the entrypoint.
The same-directory `.env` is a fallback for direct use. The Node process
writes only MCP messages to stdout.

## Tools

| Tool | Arguments and result |
| --- | --- |
| `get_collector_health` | MCP status, authenticated API and DB readiness, worker version and last check-in |
| `start_collection` | `platform`, `query`, optional `limit`, `extract_contacts`, `enrichment_limit`, `deadline_seconds`, `owner`, `request_id`. Returns a job ID promptly |
| `get_collection_status` | `job_id`. Returns phase, timestamps, result counters, errors and enrichment counts |
| `get_collection_results` | `job_id` with optional `cursor`, `limit`, `query`. Returns `data` and `next_cursor` |
| `cancel_collection` | `job_id`. Stops assignment and enrichment as soon as the worker and services reconcile |
| `search_leads` | Optional `cursor`, `limit`, `query`. Returns normalized persisted lead pages |
| `export_leads` | `job_id`, `format` (`csv` or `json`). Returns path, SHA-256 and record count |
| `extract_website_contacts` | `urls`, up to 10 per MCP call. Returns exact source pages and outcomes |
| `list_jobs` | Up to 50 recent jobs |
| `collect_maps` | Synchronous legacy entrypoint. Returns a bounded compatibility page and job ID. Use async tools for new integrations |

Map providers are `google_maps`, `yandex_maps`, and `gis`. The server limit
is 500 results per collection. Each page holds up to 50 and may be smaller
to bound response bytes. Continue until `next_cursor` is null. Job results
filter by normalized name, address, city, category or domain. Reuse the
same request ID and parameters when retrying an uncertain start. A changed
request under a retained ID returns conflict. The legacy wait tool reuses
identical arguments while the job is active and for 15 minutes after
completion. If waiting times out, it returns the job ID so the caller can
continue using status and results. The legacy output omits bulk raw
provider internals. Existing status strings `done` and `error` remain.

Responses provide JSON text and structured MCP content. Operational
errors use `isError` with a machine-readable `code` and a message. Examples
include `credential_missing`, `unauthorized`, `backend_unavailable`,
`limit_reached`, `conflict`, `not_found` and `wait_timeout`. An API-ready
result can have an absent or stale worker.

## HTTP protocol

Base URL defaults to `http://127.0.0.1:5050`. The root GET is a liveness
probe. Authenticated routes use `Authorization: Bearer <token>` and
JSON bodies. Agent inputs use camelCase on HTTP and snake_case in MCP.

| Method and path | Role and operation |
| --- | --- |
| GET `/v1/health` | Agent, database and worker readiness |
| POST `/v1/jobs` | Agent, create validated job (`platform`, `query`, `limit`, `extractContacts`, `enrichmentLimit`, `timeoutSeconds`, `requestId`, `owner`, optional provider URL) |
| GET `/v1/jobs`, GET `/v1/jobs/:id` | Agent, metadata and progress |
| GET `/v1/jobs/:id/results`, GET `/v1/leads` | Agent, paginated data |
| POST `/v1/jobs/:id/cancel`, POST `/v1/jobs/:id/export` | Agent, cancellation or an export receipt |
| POST `/v1/jobs/next` | Worker, heartbeat and atomic claim with `workerId` and `version`; an empty object means idle |
| POST `/v1/jobs/:id/heartbeat` | Worker, renew with `workerId`, `attempt`, `phase`, `count` |
| POST `/v1/jobs/:id/results` | Worker, submit `data` with the assignment identity |
| POST `/v1/jobs/:id/error` | Worker, submit an error code, message and optional partial `data` |
| POST `/v1/jobs/:id/release` | Worker, release the browser slot after closing its owned tab |
| POST `/v1/extract-website` | Agent or worker, extract public contacts from `urls` |

The legacy unauthenticated GET claim route is retired. Old automatic
workers must be upgraded together with the API. The standalone extension
and its manual exports continue to work independently.
