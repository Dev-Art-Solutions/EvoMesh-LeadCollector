/**
 * Data Collector sync: finished jobs become contract-v1 events in a local
 * outbox (SQLite, same database), and a timer delivers them.
 *
 * LeadCollector syncs on its own, with its own credential: EvoMesh is not a
 * relay, and either side can be offline without the other losing anything.
 * Delivery is at-least-once. The receiver dedupes by Idempotency-Key (the
 * event id) today, and by source_key once it has upsert-batch. See
 * EvoMesh's docs/integrations/data-collector-contract.md.
 *
 * Off unless LEADCOLLECTOR_DC_URL and LEADCOLLECTOR_DC_API_KEY are set.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '../jobs/migrations';

export const CONTRACT_VERSION = 1;

export interface DcSettings {
  url: string;
  apiKey: string;
  collections: Record<string, string>;
  upsertBatch: boolean;
  batchSize: number;
  maxAttempts: number;
  minBackoffMs: number;
  maxBackoffMs: number;
}

export function dcSettings(
  env: Record<string, string | undefined> = process.env,
): DcSettings | null {
  const url = (env.LEADCOLLECTOR_DC_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (env.LEADCOLLECTOR_DC_API_KEY || '').trim();
  if (!url || !apiKey) return null;
  if (!/^https:\/\//i.test(url) && env.LEADCOLLECTOR_DC_ALLOW_HTTP !== '1') {
    throw new Error(
      'LEADCOLLECTOR_DC_URL must be https (LEADCOLLECTOR_DC_ALLOW_HTTP=1 for a local test server)',
    );
  }
  const collections: Record<string, string> = {};
  for (const [type, name] of [
    ['business', 'LEADCOLLECTOR_DC_COLLECTION_BUSINESS'],
    ['contact', 'LEADCOLLECTOR_DC_COLLECTION_CONTACT'],
    ['source_observation', 'LEADCOLLECTOR_DC_COLLECTION_OBSERVATION'],
    ['agent_run', 'LEADCOLLECTOR_DC_COLLECTION_RUN'],
  ]) {
    const value = (env[name] || '').trim();
    if (value) collections[type] = value;
  }
  return {
    url,
    apiKey,
    collections,
    upsertBatch: env.LEADCOLLECTOR_DC_UPSERT_BATCH === '1',
    batchSize: 50,
    maxAttempts: 12,
    minBackoffMs: 5_000,
    maxBackoffMs: 1_800_000,
  };
}

function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function envelope(
  entityType: string,
  sourceKey: string,
  payload: Record<string, unknown>,
  extra: {
    observedAt?: string | null;
    sourceUrl?: string;
    jobId?: string;
    privacy?: string;
  } = {},
) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    contract_version: CONTRACT_VERSION,
    event_id: randomUUID(),
    event_type: `${entityType}.observed`,
    source_system: 'leadcollector',
    source_agent_id: 'leadcollector',
    source_job_id: extra.jobId ?? null,
    entity_type: entityType,
    source_key: sourceKey,
    observed_at: extra.observedAt || now,
    collected_at: now,
    source_url: extra.sourceUrl ?? '',
    source_method: 'leadcollector',
    content_hash: `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`,
    privacy_class: extra.privacy ?? 'business_contact',
    payload,
    metadata: { producer: 'leadcollector job export' },
    artifact_refs: [] as string[],
  };
}

type Envelope = ReturnType<typeof envelope>;

function insert(db: DatabaseSync, event: Envelope, now: number): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO dc_outbox(event_id, source_key, content_hash, entity_type, payload,
         state, attempts, next_attempt_at, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, '', ?)`,
    )
    .run(
      event.event_id,
      event.source_key,
      event.content_hash,
      event.entity_type,
      JSON.stringify(event),
      now,
    );
  return Number(result.changes) === 1;
}

function json(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Queue every finished job that was not exported yet. One transaction per
 * job, marked exported in the same transaction, so a crash re-exports the
 * whole job or none of it -- and a re-export is only duplicates. */
export function enqueueFinishedJobs(
  db: DatabaseSync,
  now = Date.now(),
): number {
  const jobs = db
    .prepare(
      `SELECT * FROM jobs WHERE status IN ('done','error','cancelled')
         AND id NOT IN (SELECT job_id FROM dc_exported_jobs) ORDER BY completed_at LIMIT 20`,
    )
    .all() as Record<string, any>[];
  let queued = 0;
  for (const job of jobs) {
    transaction(db, () => {
      const leads = db
        .prepare(
          `SELECT l.id, l.profile FROM job_leads j JOIN leads l ON l.id = j.lead_id
             WHERE j.job_id = ? ORDER BY j.position`,
        )
        .all(job.id) as { id: string; profile: string }[];
      for (const lead of leads) {
        const profile = json(lead.profile);
        const businessKey = profile.place_id
          ? `business:${profile.platform}:${profile.place_id}`
          : `business:leadcollector:${lead.id}`;
        if (
          insert(
            db,
            envelope('business', businessKey, profile, {
              observedAt: iso(profile.updated_at as number),
              sourceUrl: (profile.listing_url as string) || '',
              jobId: job.id,
            }),
            now,
          )
        )
          queued++;
        const contacts = db
          .prepare('SELECT * FROM lead_contacts WHERE lead_id = ?')
          .all(lead.id) as Record<string, any>[];
        for (const contact of contacts) {
          const payload = {
            business_key: businessKey,
            type: contact.type,
            value: contact.value,
            normalized: contact.normalized,
            source_url: contact.source_url,
            verified_at: iso(contact.verified_at),
          };
          if (
            insert(
              db,
              envelope(
                'contact',
                `contact:${businessKey}:${contact.type}:${contact.normalized}`,
                payload,
                {
                  observedAt: iso(contact.observed_at),
                  sourceUrl: contact.source_url,
                  jobId: job.id,
                },
              ),
              now,
            )
          )
            queued++;
        }
        const sources = db
          .prepare(
            'SELECT * FROM lead_sources WHERE lead_id = ? AND (job_id = ? OR job_id IS NULL)',
          )
          .all(lead.id, job.id) as Record<string, any>[];
        for (const source of sources) {
          const payload = {
            business_key: businessKey,
            platform: source.platform,
            url: source.url ?? '',
            evidence: json(source.evidence),
          };
          if (
            insert(
              db,
              envelope(
                'source_observation',
                `source_observation:leadcollector:${source.id}`,
                payload,
                {
                  observedAt: iso(source.observed_at),
                  sourceUrl: source.url ?? '',
                  jobId: job.id,
                  privacy: 'public',
                },
              ),
              now,
            )
          )
            queued++;
        }
      }
      const run = {
        job_id: job.id,
        params: json(job.params),
        status: job.status,
        phase: job.phase,
        result_count: job.result_count,
        scraped_count: job.scraped_count,
        created_at: iso(job.created_at),
        started_at: iso(job.started_at),
        completed_at: iso(job.completed_at),
        error_code: job.error_code ?? null,
      };
      if (
        insert(
          db,
          envelope('agent_run', `agent_run:leadcollector:${job.id}`, run, {
            observedAt: iso(job.completed_at),
            jobId: job.id,
            privacy: 'public',
          }),
          now,
        )
      )
        queued++;
      db.prepare(
        'INSERT OR IGNORE INTO dc_exported_jobs(job_id, exported_at) VALUES (?, ?)',
      ).run(job.id, now);
    });
  }
  return queued;
}

export interface SyncReport {
  acknowledged: number;
  retried: number;
  dead: number;
  unroutable: number;
  error: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Deliver what is due. Same semantics as EvoMesh's outbox: 2xx acks, 429
 * and 5xx retry with backoff (Retry-After honoured), 401/403 keep the event
 * and stop the round, any other 4xx is a dead letter. */
export async function syncOnce(
  db: DatabaseSync,
  settings: DcSettings,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<SyncReport> {
  const report: SyncReport = {
    acknowledged: 0,
    retried: 0,
    dead: 0,
    unroutable: 0,
    error: '',
  };
  const rows = db
    .prepare(
      `SELECT * FROM dc_outbox WHERE state IN ('pending','retry') AND next_attempt_at <= ?
         ORDER BY created_at LIMIT ?`,
    )
    .all(now, settings.batchSize * 4) as Record<string, any>[];
  const update = (
    id: string,
    state: string,
    attempts: number,
    next: number,
    error: string,
  ) =>
    db
      .prepare(
        `UPDATE dc_outbox SET state=?, attempts=?, next_attempt_at=?, last_error=?,
           acked_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acked_at END WHERE event_id=?`,
      )
      .run(state, attempts, next, error.slice(0, 500), state, now, id);
  const retry = (
    row: Record<string, any>,
    error: string,
    retryAfter?: string | null,
  ) => {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= settings.maxAttempts) {
      update(row.event_id, 'dead_letter', attempts, 0, `gave up: ${error}`);
      report.dead++;
      return;
    }
    let delay =
      Math.min(
        settings.maxBackoffMs,
        settings.minBackoffMs * 2 ** (attempts - 1),
      ) *
      (0.5 + Math.random() / 2);
    if (retryAfter && /^\d+$/.test(retryAfter))
      delay = Math.max(delay, Number(retryAfter) * 1000);
    update(row.event_id, 'retry', attempts, Math.round(now + delay), error);
    report.retried++;
  };
  for (const row of rows) {
    const collection = settings.collections[row.entity_type];
    if (!collection) {
      report.unroutable++;
      db.prepare(
        'UPDATE dc_outbox SET last_error=?, next_attempt_at=? WHERE event_id=?',
      ).run(
        `no collection configured for ${row.entity_type}`,
        now + 60_000,
        row.event_id,
      );
      continue;
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${settings.url}/collections/${collection}/records`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': settings.apiKey,
            'Idempotency-Key': row.event_id,
          },
          body: JSON.stringify({ data: JSON.parse(row.payload) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      retry(row, `network: ${(error as Error).message}`);
      continue;
    }
    if (response.status === 200 || response.status === 201) {
      update(row.event_id, 'acknowledged', Number(row.attempts), 0, '');
      report.acknowledged++;
    } else if (response.status === 401 || response.status === 403) {
      report.error = `credential rejected (${response.status}); events kept`;
      retry(row, report.error);
      break;
    } else if (response.status === 429 || response.status >= 500) {
      retry(
        row,
        `HTTP ${response.status}`,
        response.headers.get('Retry-After'),
      );
    } else {
      update(
        row.event_id,
        'dead_letter',
        Number(row.attempts),
        0,
        `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
      report.dead++;
    }
  }
  return report;
}

export function outboxCounts(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare('SELECT state, COUNT(*) AS n FROM dc_outbox GROUP BY state')
    .all() as {
    state: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((row) => [row.state, Number(row.n)]));
}
