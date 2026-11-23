# Smoke test

## Automated, no live Maps traffic

From LeadCollector, run with Node 22.13+ and pnpm 9.4:

```text
pnpm install --frozen-lockfile
pnpm build:extension
pnpm build:api
pnpm type-check
pnpm test
node --test apps/api/test/collector-contract.test.mjs
```

The HTTP and stdio contract test starts Nest on loopback, creates a temporary
SQLite database, uses separate fixture credentials, and simulates worker
check-in, claim and results delivery. It checks authorization, CORS, body
and input limits, pagination, cancelled jobs and real file exports. API
unit tests cover reopen, stale leases, delivery replay, branch identities,
source lineage, site policy, cancellation and export checksums. MV3 tests
use a deterministic Chrome port with simulated worker suspension and outages.

From EvoMesh, set `EVOMESH_LEADCOLLECTOR_TEST_REPO` to the absolute LeadCollector
checkout and run `uv run pytest tests/test_lead_researcher.py -q`. The contract
test uses EvoMesh's actual MCP client and the real Node stdio adapter with a
fixture API.

## Operator-triggered Windows test

1. Follow [Windows setup](WINDOWS_SETUP.md), including the two unpacked
   extensions in the same dedicated profile. Confirm browser status, the
   bridge connection, stdio discovery and fresh worker health. Keep one
   unrelated tab open to verify tab cleanup.
2. Ask Lead Researcher for at most five businesses in a city/category you
   have permission to research. Ask for CSV and JSON and a status update.
   Add optional public-business contact enrichment for at most two websites.
3. Verify queue, scrape and terminal statuses. Check result count against the
   exports. Inspect listing and contact source URLs and observation timestamps.
   A provider challenge should report `human_required`.
4. Submit another small job and cancel it before completion. Check the job's
   terminal state and that only its collection tab closes. Keep the unrelated
   tab open.
5. Stop and restart the API after a completion. Job status, lead IDs and
   exports must persist. If testing a running job, expect either successful
   reconciliation within the worker lease or a bounded retry on lease expiry.
   Check that a repeated request ID does not create a second job.
6. Stop the dedicated browser with EvoMesh and stop the API in its terminal.
   Leave stored artifacts available after the processes stop.

Record the Chrome, Node and EvoMesh versions, job IDs, terminal status,
record counts and whether the API and Chrome interruption cases were
covered. Leave tokens and personal data out of the test evidence.
