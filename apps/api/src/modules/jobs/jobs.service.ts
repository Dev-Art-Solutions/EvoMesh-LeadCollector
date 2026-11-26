import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { setting, stateDirectory } from './collector.config';
import {
  digest,
  ingestLead,
  LeadSnapshot,
  LeadSource,
  observedContacts,
  searchText,
  storeContacts,
  storeSource,
} from './leads';
import { migrate, transaction } from './migrations';
import {
  Assignment,
  CreateJobInput,
  Job,
  JobPlatform,
  JobStatus,
} from './jobs.types';
import type { ContactResult } from '../app/extractors';
import { writeArtifact } from './exports';

type JobRow = {
  id: string;
  params: string;
  status: JobStatus;
  phase: string;
  result_count: number;
  scraped_count: number;
  error: string | null;
  error_code: string | null;
  worker_id: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  deadline_at: number;
  lease_expires_at: number | null;
  submission_hash: string | null;
};

type Page = { cursor?: number; limit?: number; query?: string };
type EnrichmentTask = {
  jobId: string;
  leadId: string;
  url: string;
  lease: number;
};
const TERMINAL = ['done', 'error', 'cancelled'];
const MAP_HOSTS: Record<JobPlatform, RegExp> = {
  google_maps: /^(www\.)?google\.com$/,
  yandex_maps: /^(www\.)?yandex\.(com|ru|by|kz|uz)$/,
  gis: /^(www\.)?2gis\.(ru|com|kz|by|az|kg|uz)$/,
};

function mapsUrl(value: string | undefined, platform: JobPlatform) {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      MAP_HOSTS[platform].test(url.hostname) &&
      (platform === 'gis'
        ? /\/search\//.test(url.pathname)
        : platform === 'google_maps'
          ? url.pathname.startsWith('/maps/search/')
          : url.pathname.startsWith('/maps') &&
            (url.pathname.includes('/search') || url.searchParams.has('text')))
    ) {
      return url.href;
    }
  } catch {
    // Return the same validation response for malformed and unsupported URLs.
  }
  throw new BadRequestException(
    'Use an HTTPS map search URL on the selected provider',
  );
}

function boundedPage(rows: Record<string, unknown>[], limit: number) {
  const data: LeadSnapshot[] = [];
  let cursor: number | undefined;
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const snapshot = String(row.snapshot);
    bytes += Buffer.byteLength(snapshot);
    if (data.length && bytes > 48 * 1024) break;
    data.push(JSON.parse(snapshot));
    cursor = Number(row.position);
  }
  return {
    schema_version: 1,
    data,
    next_cursor: data.length < rows.length ? cursor : null,
  };
}

@Injectable()
export class JobsService implements OnModuleDestroy {
  private readonly db: DatabaseSync;
  private readonly leaseMs =
    setting('LEADCOLLECTOR_LEASE_SECONDS', 90, 45, 600) * 1000;
  private readonly maxActive = setting('LEADCOLLECTOR_MAX_ACTIVE', 1, 1, 4);
  private readonly maxPending = setting(
    'LEADCOLLECTOR_MAX_PENDING',
    25,
    1,
    100,
  );
  private readonly maxAttempts = setting('LEADCOLLECTOR_MAX_ATTEMPTS', 2, 1, 5);
  private readonly retentionMs =
    setting('LEADCOLLECTOR_JOB_RETENTION_DAYS', 30, 0, 3650) * 86400000;
  private readonly enrichmentWorker = randomUUID();
  private nextPruneAt = 0;

  constructor() {
    // Files are private to this account on POSIX. Windows inherits the parent ACL.
    const directory = stateDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'collector.sqlite'));
    try {
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  onModuleDestroy() {
    this.db.close();
  }

  private row(id: string): JobRow {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as
      | JobRow
      | undefined;
    if (!row) throw new NotFoundException('Collection job not found');
    return row;
  }

  private view(row: JobRow): Job {
    return {
      id: row.id,
      ...JSON.parse(row.params),
      status: row.status,
      phase: row.phase,
      results: row.result_count,
      scrapedCount: row.scraped_count,
      error: row.error ?? undefined,
      errorCode: row.error_code ?? undefined,
      workerId: row.worker_id ?? undefined,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      deadlineAt: row.deadline_at,
      leaseExpiresAt: row.lease_expires_at ?? undefined,
    };
  }

  // Commit maintenance even when the following operation rejects a stale attempt.
  maintain(now = Date.now()) {
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE jobs SET status='error', phase='error', error_code='deadline_exceeded',
        error='Collection deadline expired', completed_at=?, updated_at=? WHERE status IN ('pending','running') AND deadline_at<=?`,
        )
        .run(now, now, now);
      this.db
        .prepare(
          `UPDATE job_leads SET snapshot=json_set(snapshot,'$.enrichment',json('{"status":"failed","attempted_urls":[],"error":"deadline_exceeded"}'))
        WHERE (job_id,lead_id) IN (SELECT r.job_id,r.lead_id FROM enrichment_runs r
          JOIN jobs j ON j.id=r.job_id WHERE r.state='queued' AND j.error_code='deadline_exceeded')`,
        )
        .run();
      this.db
        .prepare(
          `UPDATE enrichment_runs SET state='failed', detail='{"error":"deadline_exceeded"}', updated_at=?
        WHERE state='queued' AND job_id IN (SELECT id FROM jobs WHERE error_code='deadline_exceeded')`,
        )
        .run(now);
      this.db
        .prepare(
          `UPDATE jobs SET status='error', phase='error', error_code='worker_lost',
        error='Browser worker did not renew its lease', completed_at=?, updated_at=?, lease_expires_at=NULL
        WHERE status='running' AND phase IN ('opening_map','scraping') AND lease_expires_at<=? AND attempt>=?`,
        )
        .run(now, now, now, this.maxAttempts);
      this.db
        .prepare(
          `UPDATE jobs SET status='pending', phase='queued', worker_id=NULL, lease_expires_at=NULL,
        scraped_count=0, updated_at=? WHERE status='running' AND phase IN ('opening_map','scraping') AND lease_expires_at<=?`,
        )
        .run(now, now);
      if (now >= this.nextPruneAt) {
        if (this.retentionMs)
          this.db
            .prepare('DELETE FROM jobs WHERE completed_at < ?')
            .run(now - this.retentionMs);
        this.db
          .prepare('DELETE FROM workers WHERE last_seen_at < ?')
          .run(now - 86400000);
      }
    });
    if (now >= this.nextPruneAt) this.nextPruneAt = now + 3600000;
  }

  create(input: CreateJobInput): Job {
    const now = Date.now();
    this.maintain(now);
    const params = JSON.stringify({
      platform: input.platform,
      query: input.query.trim(),
      url: mapsUrl(input.url, input.platform),
      limit: input.limit ?? 200,
      extractContacts: input.extractContacts ?? false,
      fields: input.fields,
      owner: input.owner,
      timeoutSeconds: input.timeoutSeconds ?? 600,
      enrichmentLimit: input.enrichmentLimit ?? 20,
    });
    return transaction(this.db, () => {
      if (input.requestId) {
        const existing = this.db
          .prepare('SELECT * FROM jobs WHERE request_id=?')
          .get(input.requestId) as JobRow | undefined;
        if (
          existing &&
          input.requestId.startsWith('legacy:') &&
          existing.completed_at &&
          existing.completed_at < now - 15 * 60000
        ) {
          this.db
            .prepare('UPDATE jobs SET request_id=NULL WHERE id=?')
            .run(existing.id);
        } else if (existing) {
          if (existing.params !== params)
            throw new ConflictException(
              'Request ID already used with different parameters',
            );
          return this.view(existing);
        }
      }
      const pending = this.db
        .prepare("SELECT count(*) AS count FROM jobs WHERE status='pending'")
        .get();
      if (Number(pending.count) >= this.maxPending)
        throw new HttpException('Collection queue is full', 429);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO jobs(id,request_id,params,status,phase,created_at,updated_at,deadline_at)
        VALUES(?,?,?,'pending','queued',?,?,?)`,
        )
        .run(
          id,
          input.requestId ?? null,
          params,
          now,
          now,
          now + (input.timeoutSeconds ?? 600) * 1000,
        );
      return this.view(this.row(id));
    });
  }

  private workerSeen(workerId: string, version: string | null, now: number) {
    if (version === null) {
      this.db
        .prepare('UPDATE workers SET last_seen_at=? WHERE id=?')
        .run(now, workerId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO workers VALUES(?,?,?) ON CONFLICT(id)
      DO UPDATE SET last_seen_at=excluded.last_seen_at,version=excluded.version`,
      )
      .run(workerId, now, version);
  }

  claim(workerId: string, version: string): Job | null {
    const now = Date.now();
    this.maintain(now);
    return transaction(this.db, () => {
      this.workerSeen(workerId, version, now);
      const existing = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status='running' AND phase IN ('opening_map','scraping')
        AND worker_id=? AND lease_expires_at>?`,
        )
        .get(workerId, now) as JobRow | undefined;
      if (existing) return this.view(existing);
      // Cancelled jobs occupy a browser slot until the tab closes or its lease expires.
      const leases = this.db
        .prepare(
          `SELECT worker_id FROM jobs WHERE lease_expires_at>? AND
        (phase IN ('opening_map','scraping') OR (status IN ('cancelled','error') AND worker_id IS NOT NULL
        AND submission_hash IS NULL))`,
        )
        .all(now);
      if (
        leases.length >= this.maxActive ||
        leases.some((lease) => lease.worker_id === workerId)
      )
        return null;
      const row = this.db
        .prepare(
          `UPDATE jobs SET status='running', phase='opening_map', worker_id=?,
        attempt=attempt+1, started_at=coalesce(started_at,?), updated_at=?, lease_expires_at=min(deadline_at,?)
        WHERE id=(SELECT id FROM jobs WHERE status='pending' ORDER BY created_at,rowid LIMIT 1) RETURNING *`,
        )
        .get(workerId, now, now, now + this.leaseMs) as JobRow | undefined;
      return row ? this.view(row) : null;
    });
  }

  private checkAssignment(row: JobRow, assignment: Assignment) {
    if (
      row.worker_id !== assignment.workerId ||
      row.attempt !== assignment.attempt
    ) {
      throw new ConflictException('Stale collection attempt');
    }
  }

  private checkRunning(row: JobRow, now: number) {
    if (
      row.status !== 'running' ||
      !['opening_map', 'scraping'].includes(row.phase) ||
      row.lease_expires_at <= now
    ) {
      throw new ConflictException('Collection assignment is no longer active');
    }
  }

  heartbeat(
    id: string,
    assignment: Assignment,
    phase: 'opening_map' | 'scraping',
    count: number,
  ): Job {
    const now = Date.now();
    this.maintain(now);
    return transaction(this.db, () => {
      const row = this.row(id);
      this.checkAssignment(row, assignment);
      this.workerSeen(assignment.workerId, null, now);
      if (TERMINAL.includes(row.status) || row.phase === 'enriching')
        return this.view(row);
      this.checkRunning(row, now);
      const safeCount = Math.min(count, this.view(row).limit);
      this.db
        .prepare(
          `UPDATE jobs SET phase=?,scraped_count=max(scraped_count,?),updated_at=?,lease_expires_at=? WHERE id=?`,
        )
        .run(
          row.phase === 'scraping' ? 'scraping' : phase,
          safeCount,
          now,
          Math.min(row.deadline_at, now + this.leaseMs),
          id,
        );
      return this.view(this.row(id));
    });
  }

  release(id: string, assignment: Assignment) {
    const now = Date.now();
    return transaction(this.db, () => {
      const row = this.row(id);
      this.checkAssignment(row, assignment);
      if (!TERMINAL.includes(row.status))
        throw new ConflictException('Collection assignment is active');
      this.db
        .prepare(
          'UPDATE jobs SET lease_expires_at=NULL,updated_at=? WHERE id=?',
        )
        .run(now, id);
    });
  }

  submit(
    id: string,
    assignment: Assignment,
    data: Record<string, unknown>[],
  ): Job {
    const now = Date.now();
    this.maintain(now);
    const hash = digest(JSON.stringify(data));
    return transaction(this.db, () => {
      const row = this.row(id);
      this.checkAssignment(row, assignment);
      if (row.submission_hash === hash) return this.view(row);
      this.checkRunning(row, now);
      const job = this.view(row);
      if (data.length > job.limit)
        throw new BadRequestException('Submission exceeds requested job limit');
      let count = 0;
      let queued = 0;
      const insertRun = this.db.prepare(
        "INSERT INTO enrichment_runs VALUES(?,?,?,?,'queued',NULL,?)",
      );
      const updateSnapshot = this.db.prepare(
        'UPDATE job_leads SET snapshot=? WHERE job_id=? AND lead_id=?',
      );
      for (const record of data) {
        const lead = ingestLead(
          this.db,
          id,
          job.platform,
          record,
          count + 1,
          now,
        );
        if (!lead) continue;
        count++;
        const enqueue =
          job.extractContacts &&
          lead.website_url &&
          queued < job.enrichmentLimit;
        if (enqueue) {
          insertRun.run(id, id, lead.id, lead.website_url, now);
          queued++;
        }
        if (job.extractContacts) {
          lead.enrichment = {
            status: enqueue ? 'queued' : 'skipped',
            attempted_urls: [],
            error: enqueue
              ? undefined
              : lead.website_url
                ? 'enrichment_limit'
                : 'no_website',
          };
          updateSnapshot.run(JSON.stringify(lead), id, lead.id);
        }
      }
      const status = queued ? 'running' : 'done';
      this.db
        .prepare(
          `UPDATE jobs SET status=?,phase=?,submission_hash=?,scraped_count=?,result_count=?,
        lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          status,
          queued ? 'enriching' : status,
          hash,
          data.length,
          count,
          queued ? null : now,
          now,
          id,
        );
      return this.view(this.row(id));
    });
  }

  fail(
    id: string,
    assignment: Assignment,
    code: string,
    error: string,
    data: Record<string, unknown>[] = [],
  ): Job {
    const now = Date.now();
    this.maintain(now);
    return transaction(this.db, () => {
      const row = this.row(id);
      this.checkAssignment(row, assignment);
      if (
        row.status === 'error' &&
        row.error_code === code &&
        row.error === error
      )
        return this.view(row);
      this.checkRunning(row, now);
      const job = this.view(row);
      let count = 0;
      if (data.length > job.limit)
        throw new BadRequestException('Submission exceeds requested job limit');
      for (const record of data) {
        if (ingestLead(this.db, id, job.platform, record, count + 1, now))
          count++;
      }
      this.db
        .prepare(
          `UPDATE jobs SET status='error',phase='error',error_code=?,error=?,lease_expires_at=NULL,
        result_count=?,scraped_count=max(scraped_count,?),completed_at=?,updated_at=? WHERE id=?`,
        )
        .run(code, error, count, data.length, now, now, id);
      return this.view(this.row(id));
    });
  }

  /** Run a finished, failed or cancelled job's search again as a new job
   * (same parameters, new id); the old one and its results stay. */
  retry(id: string): Job {
    const row = this.row(id);
    if (!TERMINAL.includes(row.status))
      throw new ConflictException('Job is still running; cancel it first');
    const params = JSON.parse(String(row.params)) as CreateJobInput & { url?: string };
    return this.create({ ...params, requestId: `retry-${id.slice(0, 8)}-${Date.now().toString(36)}` });
  }

  cancel(id: string): Job {
    const now = Date.now();
    this.maintain(now);
    return transaction(this.db, () => {
      const row = this.row(id);
      if (row.status === 'cancelled') return this.view(row);
      if (TERMINAL.includes(row.status))
        throw new ConflictException('Collection is already terminal');
      this.db
        .prepare(
          `UPDATE jobs SET status='cancelled',phase='cancelled',error_code='cancelled',
        enrichment_lease_at=NULL,completed_at=?,updated_at=? WHERE id=?`,
        )
        .run(now, now, id);
      this.db
        .prepare(
          `UPDATE job_leads SET snapshot=json_set(snapshot,'$.enrichment',json('{"status":"cancelled","attempted_urls":[]}'))
        WHERE job_id=? AND lead_id IN (SELECT lead_id FROM enrichment_runs WHERE job_id=? AND state='queued')`,
        )
        .run(id, id);
      this.db
        .prepare(
          "UPDATE enrichment_runs SET state='cancelled',updated_at=? WHERE job_id=? AND state='queued'",
        )
        .run(now, id);
      return this.view(this.row(id));
    });
  }

  /** Just the phase, for a loop that only needs to know whether a job is
   * still enriching: status() recounts the job's enrichment and leads, and
   * the enrichment processor calling it per job per site took most of the
   * backend's one thread (found 2026-11-26, 28 s of a 45 s profile). */
  phase(id: string): string | null {
    const row = this.db.prepare('SELECT phase FROM jobs WHERE id=?').get(id) as { phase: string } | undefined;
    return row?.phase ?? null;
  }

  status(id: string) {
    this.maintain();
    const job = this.view(this.row(id));
    const enrichment = Object.fromEntries(
      this.db
        .prepare(
          `SELECT state,count(*) AS count FROM enrichment_runs
      WHERE job_id=? GROUP BY state`,
        )
        .all(id)
        .map((row) => [row.state, row.count]),
    );
    const completed = Object.values(enrichment).reduce<number>(
      (sum, count) => sum + Number(count),
      0,
    );
    return {
      ...job,
      enrichment: { ...enrichment, skipped: job.results - completed },
      schema_version: 1,
    };
  }

  list() {
    this.maintain();
    return (
      this.db
        .prepare('SELECT * FROM jobs ORDER BY created_at DESC,id LIMIT 50')
        .all() as JobRow[]
    ).map((row) => this.view(row));
  }

  results(id: string, { cursor = 0, limit = 10, query = '' }: Page) {
    this.maintain();
    this.row(id);
    const rows = this.db
      .prepare(
        `SELECT position,snapshot FROM job_leads
      WHERE job_id=? AND position>? AND instr(search_text,?)>0
      ORDER BY position LIMIT ?`,
      )
      .all(id, cursor, searchText(query), limit + 1);
    return boundedPage(rows, limit);
  }

  search({ cursor = 0, limit = 10, query = '' }: Page) {
    const rows = this.db
      .prepare(
        `SELECT rowid AS position,id,profile FROM leads WHERE rowid>? AND instr(search_text,?)>0
      ORDER BY rowid LIMIT ?`,
      )
      .all(cursor, searchText(query), limit + 1);
    const sources = this.db.prepare(
      'SELECT evidence FROM lead_sources WHERE lead_id=? ORDER BY id DESC LIMIT 3',
    );
    const contacts = this.db
      .prepare(`SELECT type,value,normalized,nullif(source_url,'') AS source_url,
      observed_at,verified_at AS last_verified_at FROM lead_contacts WHERE lead_id=? ORDER BY observed_at DESC,type,normalized LIMIT 12`);
    return boundedPage(
      rows.map((row) => ({
        position: row.position,
        snapshot: JSON.stringify({
          ...JSON.parse(String(row.profile)),
          sources: sources
            .all(row.id)
            .map((source) => JSON.parse(String(source.evidence))),
          contacts: contacts.all(row.id),
        }),
      })),
      limit,
    );
  }

  health() {
    this.maintain();
    const now = Date.now();
    const lastWorker = this.db
      .prepare(
        'SELECT last_seen_at,version FROM workers ORDER BY last_seen_at DESC LIMIT 1',
      )
      .get();
    const lastSeenAt = lastWorker ? Number(lastWorker.last_seen_at) : null;
    const workerReady = lastSeenAt !== null && now - lastSeenAt <= this.leaseMs;
    return {
      status: 'ok',
      service: 'evomesh-leadcollector',
      database: 'ready',
      schema_version: 1,
      worker: {
        status: workerReady ? 'ready' : 'not_seen_recently',
        last_seen_at: lastSeenAt,
        version: lastWorker?.version ?? null,
      },
    };
  }

  nextEnrichment(): EnrichmentTask | undefined {
    const now = Date.now();
    this.maintain(now);
    // One site at a time per job (its lease), but jobs no longer wait for
    // each other: a whole-backend lease kept every job but one idle and made
    // enrichment, not the map, the pace of a collection campaign.
    return transaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT r.job_id,r.lead_id,r.url FROM enrichment_runs r
        JOIN jobs j ON j.id=r.job_id WHERE j.status='running' AND j.phase='enriching' AND r.state='queued'
          AND (j.enrichment_lease_at IS NULL OR j.enrichment_lease_at<=?)
        ORDER BY j.created_at, r.job_id, r.lead_id LIMIT 1`,
        )
        .get(now);
      if (!row) return;
      const lease = now + 20000;
      this.db
        .prepare(
          'UPDATE jobs SET enrichment_worker=?,enrichment_lease_at=? WHERE id=?',
        )
        .run(this.enrichmentWorker, lease, row.job_id);
      return {
        jobId: String(row.job_id),
        leadId: String(row.lead_id),
        url: String(row.url),
        lease,
      };
    });
  }

  finishEnrichment(task: EnrichmentTask, result: ContactResult) {
    const now = Date.now();
    this.maintain(now);
    transaction(this.db, () => {
      const active = this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE id=? AND status='running' AND phase='enriching'
        AND enrichment_worker=? AND enrichment_lease_at=? AND enrichment_lease_at>?`,
        )
        .get(task.jobId, this.enrichmentWorker, task.lease, now);
      if (!active) return;
      const row = this.db
        .prepare('SELECT snapshot FROM job_leads WHERE job_id=? AND lead_id=?')
        .get(task.jobId, task.leadId);
      const snapshot = JSON.parse(String(row.snapshot)) as LeadSnapshot;
      for (const page of result.pages || []) {
        const contacts = observedContacts({ ...page }, page.url, now);
        const source: LeadSource = {
          kind: 'website_contact',
          platform: 'website',
          url: page.url,
          observed_at: now,
          quality: 'observed',
          availability: 'public',
          fields: {
            public_contacts: contacts.map(({ type, value }) => ({
              type,
              value,
            })),
          },
        };
        storeSource(this.db, task.jobId, task.leadId, source);
        storeContacts(this.db, task.leadId, contacts);
        snapshot.sources.push(source);
        snapshot.contacts.push(...contacts);
      }
      if (result.scan) {
        const source: LeadSource = {
          kind: 'website_technology',
          platform: 'website',
          url: result.scan.url,
          observed_at: now,
          quality: 'observed',
          availability: 'public',
          fields: result.scan as unknown as Record<string, unknown>,
        };
        storeSource(this.db, task.jobId, task.leadId, source);
        snapshot.sources.push(source);
      }
      snapshot.enrichment = {
        status: result.status ?? 'failed',
        attempted_urls: result.attempted_urls ?? [],
        error: result.error,
      };
      this.db
        .prepare('UPDATE job_leads SET snapshot=? WHERE job_id=? AND lead_id=?')
        .run(JSON.stringify(snapshot), task.jobId, task.leadId);
      this.db
        .prepare(
          'UPDATE enrichment_runs SET state=?,detail=?,updated_at=? WHERE job_id=? AND lead_id=?',
        )
        .run(
          result.status ?? 'failed',
          JSON.stringify({
            attempted_urls: result.attempted_urls,
            error: result.error,
          }),
          now,
          task.jobId,
          task.leadId,
        );
      const remaining = this.db
        .prepare(
          "SELECT 1 FROM enrichment_runs WHERE job_id=? AND state='queued'",
        )
        .get(task.jobId);
      this.db
        .prepare(
          `UPDATE jobs SET status=?,phase=?,enrichment_lease_at=NULL,completed_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          remaining ? 'running' : 'done',
          remaining ? 'enriching' : 'done',
          remaining ? null : now,
          now,
          task.jobId,
        );
    });
  }

  export(id: string, format: 'csv' | 'json') {
    this.maintain();
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!TERMINAL.includes(row.status))
        throw new ConflictException(
          'Wait for collection or cancel before exporting',
        );
      const snapshots = this.db
        .prepare(
          'SELECT snapshot FROM job_leads WHERE job_id=? ORDER BY position',
        )
        .all(id)
        .map((entry) => JSON.parse(String(entry.snapshot)) as LeadSnapshot);
      return writeArtifact(this.db, id, format, snapshots);
    });
  }
}
