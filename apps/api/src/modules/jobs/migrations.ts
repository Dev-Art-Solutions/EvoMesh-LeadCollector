import type { DatabaseSync } from 'node:sqlite';

const migrations = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    request_id TEXT UNIQUE,
    params TEXT NOT NULL CHECK(json_valid(params)),
    status TEXT NOT NULL CHECK(status IN ('pending','running','done','error','cancelled')),
    phase TEXT NOT NULL CHECK(phase IN ('queued','opening_map','scraping','enriching','done','error','cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    deadline_at INTEGER NOT NULL,
    worker_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    lease_expires_at INTEGER,
    result_count INTEGER NOT NULL DEFAULT 0 CHECK(result_count >= 0),
    scraped_count INTEGER NOT NULL DEFAULT 0 CHECK(scraped_count >= 0),
    submission_hash TEXT,
    enrichment_worker TEXT,
    enrichment_lease_at INTEGER,
    error_code TEXT,
    error TEXT
  ) STRICT;
  CREATE INDEX jobs_dispatch ON jobs(status, phase, created_at, id);
  CREATE INDEX jobs_lease ON jobs(worker_id, lease_expires_at);
  CREATE INDEX jobs_retention ON jobs(completed_at);

  CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    last_seen_at INTEGER NOT NULL,
    version TEXT NOT NULL
  ) STRICT;

  CREATE TABLE leads (
    id TEXT PRIMARY KEY,
    fallback_key TEXT,
    name TEXT NOT NULL,
    search_text TEXT NOT NULL,
    profile TEXT NOT NULL CHECK(json_valid(profile)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX leads_fallback ON leads(fallback_key);
  CREATE TABLE provider_ids (
    platform TEXT NOT NULL,
    place_id TEXT NOT NULL,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    PRIMARY KEY(platform, place_id)
  ) STRICT;
  CREATE INDEX provider_ids_lead ON provider_ids(lead_id, platform);

  CREATE TABLE job_leads (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    search_text TEXT NOT NULL,
    PRIMARY KEY(job_id, lead_id),
    UNIQUE(job_id, position)
  ) STRICT;

  CREATE TABLE lead_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    platform TEXT NOT NULL,
    url TEXT,
    observed_at INTEGER NOT NULL,
    evidence TEXT NOT NULL CHECK(json_valid(evidence))
  ) STRICT;
  CREATE INDEX lead_sources_lead ON lead_sources(lead_id, id);

  CREATE TABLE lead_contacts (
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('email','phone','social')),
    normalized TEXT NOT NULL,
    source_url TEXT NOT NULL,
    value TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    verified_at INTEGER,
    PRIMARY KEY(lead_id, type, normalized, source_url)
  ) STRICT;

  CREATE TABLE enrichment_runs (
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    original_job_id TEXT NOT NULL,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','found','not_found','unavailable','blocked','failed','cancelled')),
    detail TEXT CHECK(detail IS NULL OR json_valid(detail)),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(original_job_id, lead_id)
  ) STRICT;
  CREATE INDEX enrichment_queue ON enrichment_runs(state, job_id, lead_id);

  CREATE TABLE export_artifacts (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    original_job_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL CHECK(format IN ('json','csv')),
    record_count INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    generated_at INTEGER NOT NULL
  ) STRICT;
  `,
  // 2: the Data Collector outbox (modules/datacollector). Additive.
  `
  CREATE TABLE dc_outbox (
    event_id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    state TEXT NOT NULL CHECK(state IN ('pending','retry','acknowledged','dead_letter','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    UNIQUE(source_key, content_hash)
  ) STRICT;
  CREATE INDEX dc_outbox_due ON dc_outbox(state, next_attempt_at);
  CREATE TABLE dc_exported_jobs (
    job_id TEXT PRIMARY KEY,
    exported_at INTEGER NOT NULL
  ) STRICT;
  `,
];

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function migrate(db: DatabaseSync) {
  db.exec(
    'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;',
  );
  transaction(db, () => {
    const { user_version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (user_version > migrations.length)
      throw new Error('LeadCollector database requires a newer API');
    for (let index = user_version; index < migrations.length; index++) {
      db.exec(migrations[index]);
      db.exec(`PRAGMA user_version=${index + 1}`);
    }
  });
}
