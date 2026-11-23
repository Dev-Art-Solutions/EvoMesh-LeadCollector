---
name: collect-leads
description: Collect bounded public business listings through the local EvoMesh-LeadCollector MCP server and export normalized leads and source evidence.
---

# Collect public business leads

Start with `get_collector_health`. Collection needs the authenticated API
and a recent worker check-in from the dedicated Chrome profile.

Call `start_collection` for the requested provider, city and category.
Use a bounded limit, include an idempotency key, and enable website
enrichment only when requested. Keep the job ID. If a start response is
lost, retry with the same key and parameters.

Read `get_collection_status` as the job progresses. On a stop request, use
`cancel_collection`. If the job stays active after this turn, report the job
ID so the caller can resume checking it. Report provider challenges and
wait for the operator.

Use `get_collection_results` with its cursor for each page you need to
inspect. Call `export_leads` for CSV and JSON artifacts after a terminal
status. Report the artifact paths and exact counts, including partial
results and skipped, blocked or failed enrichment. Cite observed source
URLs. Keep missing contact fields unknown and collect only public business
data within the provider's terms and applicable law.
