/**
 * Campaigns: many map searches ("<category> in <location>") run as one task.
 *
 * A campaign is rows in SQLite, so it survives restarts and needs no driver
 * process. The scheduler (campaigns.service.ts) feeds one search at a time
 * to the browser worker and keeps several more enriching, taking the next
 * search from the running campaign with the highest priority (round-robin
 * between equals). A new campaign therefore runs beside the ones already
 * going instead of waiting for them to finish.
 *
 * Pure functions over the database, so the scheduler's rules are testable
 * without timers.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '../jobs/migrations';
import { CATEGORY_PRESETS, languageFor } from './presets';

export const CAMPAIGN_STATES = ['running', 'paused', 'stopped', 'done'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATES)[number];
export const MAX_CAMPAIGN_ITEMS = 250_000;

export interface CampaignInput {
  name: string;
  locations: string[];
  categories?: string[];
  preset?: string;
  country?: string;
  language?: string;
  priority?: number;
  limit?: number;
  extractContacts?: boolean;
  enrichmentLimit?: number;
  timeoutSeconds?: number;
  owner?: string;
  status?: 'running' | 'paused';
}

export interface CampaignParams {
  platform: 'google_maps';
  country: string;
  language: string;
  limit: number;
  extractContacts: boolean;
  enrichmentLimit: number;
  timeoutSeconds: number;
  categories: string[];
  preset: string | null;
  locations: number;
}

export class CampaignError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

type Row = Record<string, any>;

export function createCampaign(db: DatabaseSync, input: CampaignInput, now = Date.now()) {
  const locations = [...new Set(input.locations.map((l) => l.trim()).filter(Boolean))];
  const categories = input.categories?.length
    ? [...new Set(input.categories.map((c) => c.trim()).filter(Boolean))]
    : CATEGORY_PRESETS[input.preset ?? 'smb'];
  if (!categories) throw new CampaignError('invalid', `unknown preset '${input.preset}'`);
  if (!locations.length) throw new CampaignError('invalid', 'at least one location is required');
  if (locations.length * categories.length > MAX_CAMPAIGN_ITEMS)
    throw new CampaignError(
      'invalid',
      `${locations.length * categories.length} searches is over ${MAX_CAMPAIGN_ITEMS}; split the campaign`,
    );
  const country = (input.country ?? 'us').toLowerCase();
  const params: CampaignParams = {
    platform: 'google_maps',
    country,
    language: input.language ?? languageFor(country),
    limit: input.limit ?? 500,
    extractContacts: input.extractContacts ?? true,
    enrichmentLimit: input.enrichmentLimit ?? 500,
    timeoutSeconds: input.timeoutSeconds ?? 7200,
    categories,
    preset: input.categories?.length ? null : (input.preset ?? 'smb'),
    locations: locations.length,
  };
  const id = randomUUID();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO campaigns(id, name, status, priority, params, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      input.status ?? 'running',
      input.priority ?? 0,
      JSON.stringify(params),
      input.owner ?? null,
      now,
      now,
    );
    const item = db.prepare(
      `INSERT INTO campaign_items(campaign_id, position, query, location, category, status, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    let position = 0;
    // Location-major: a place is finished before the next one starts, so
    // partial progress is whole towns rather than a thin slice of every town.
    for (const location of locations)
      for (const category of categories)
        item.run(id, position++, `${category} in ${location}`, location, category, now);
  });
  return campaignSummary(db, id);
}

export function mapsSearchUrl(query: string, params: Pick<CampaignParams, 'language' | 'country'>) {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=${encodeURIComponent(
    params.language,
  )}&gl=${encodeURIComponent(params.country)}`;
}

type ItemCounts = Record<'pending' | 'active' | 'done' | 'failed' | 'cancelled', number>;

function counts(db: DatabaseSync, id: string): ItemCounts {
  const out: ItemCounts = { pending: 0, active: 0, done: 0, failed: 0, cancelled: 0 };
  for (const row of db
    .prepare('SELECT status, COUNT(*) n FROM campaign_items WHERE campaign_id=? GROUP BY status')
    .all(id) as Row[])
    out[String(row.status) as keyof ItemCounts] = Number(row.n);
  return out;
}

export function campaignSummary(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id) as Row | undefined;
  if (!row) throw new CampaignError('not_found', 'campaign not found');
  const params = JSON.parse(String(row.params)) as CampaignParams;
  const items = counts(db, id);
  const total = Object.values(items).reduce((a, b) => a + b, 0);
  const leads = Number(
    (db.prepare('SELECT COALESCE(SUM(results),0) n FROM campaign_items WHERE campaign_id=?').get(id) as Row).n,
  );
  return {
    id,
    name: String(row.name),
    status: String(row.status) as CampaignStatus,
    priority: Number(row.priority),
    owner: row.owner ?? null,
    country: params.country,
    language: params.language,
    categories: params.categories.length,
    preset: params.preset,
    locations: params.locations,
    searches: { total, ...items },
    progress: total ? Math.round((1000 * (items.done + items.failed + items.cancelled)) / total) / 10 : 100,
    leads,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function listCampaigns(db: DatabaseSync) {
  return (db.prepare('SELECT id FROM campaigns ORDER BY created_at DESC').all() as Row[]).map((r) =>
    campaignSummary(db, String(r.id)),
  );
}

/** A campaign with what is happening in it right now. */
export function campaignDetail(db: DatabaseSync, id: string) {
  const summary = campaignSummary(db, id);
  const active = db
    .prepare(
      `SELECT i.position, i.query, i.job_id, j.status, j.phase, j.result_count
         FROM campaign_items i LEFT JOIN jobs j ON j.id = i.job_id
        WHERE i.campaign_id=? AND i.status='active' ORDER BY i.position`,
    )
    .all(id) as Row[];
  const failed = db
    .prepare(
      `SELECT i.position, i.query, i.attempts, j.error_code FROM campaign_items i
         LEFT JOIN jobs j ON j.id = i.job_id
        WHERE i.campaign_id=? AND i.status='failed' ORDER BY i.updated_at DESC LIMIT 10`,
    )
    .all(id) as Row[];
  const next = db
    .prepare(
      `SELECT query FROM campaign_items WHERE campaign_id=? AND status='pending' ORDER BY position LIMIT 3`,
    )
    .all(id) as Row[];
  return {
    ...summary,
    in_flight: active.map((r) => ({
      query: r.query,
      job_id: r.job_id,
      status: r.status ?? 'unknown',
      phase: r.phase ?? 'unknown',
      results: Number(r.result_count ?? 0),
    })),
    recent_failures: failed.map((r) => ({ query: r.query, attempts: r.attempts, error: r.error_code })),
    next: next.map((r) => String(r.query)),
  };
}

/** Pause keeps running searches going and starts no new ones; stop also
 * returns the job ids to cancel. Resume restarts a paused or stopped
 * campaign, searches cancelled by the stop included. */
export function changeCampaign(
  db: DatabaseSync,
  id: string,
  action: 'pause' | 'resume' | 'stop',
  now = Date.now(),
): { cancel: string[] } {
  return transaction(db, () => {
    const row = db.prepare('SELECT status FROM campaigns WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new CampaignError('not_found', 'campaign not found');
    const status = String(row.status);
    if (action === 'pause') {
      if (status !== 'running') throw new CampaignError('conflict', `campaign is ${status}`);
      db.prepare("UPDATE campaigns SET status='paused', updated_at=? WHERE id=?").run(now, id);
      return { cancel: [] };
    }
    if (action === 'resume') {
      if (status === 'running') throw new CampaignError('conflict', 'campaign is already running');
      db.prepare(
        "UPDATE campaign_items SET status='pending', updated_at=? WHERE campaign_id=? AND status='cancelled'",
      ).run(now, id);
      db.prepare("UPDATE campaigns SET status='running', updated_at=? WHERE id=?").run(now, id);
      return { cancel: [] };
    }
    const active = db
      .prepare("SELECT job_id FROM campaign_items WHERE campaign_id=? AND status='active'")
      .all(id) as Row[];
    db.prepare(
      "UPDATE campaign_items SET status='cancelled', updated_at=? WHERE campaign_id=? AND status IN ('pending','active')",
    ).run(now, id);
    db.prepare("UPDATE campaigns SET status='stopped', updated_at=? WHERE id=?").run(now, id);
    return { cancel: active.map((r) => String(r.job_id)).filter(Boolean) };
  });
}

export function setPriority(db: DatabaseSync, id: string, priority: number, now = Date.now()) {
  const changed = db
    .prepare('UPDATE campaigns SET priority=?, updated_at=? WHERE id=?')
    .run(priority, now, id).changes;
  if (!Number(changed)) throw new CampaignError('not_found', 'campaign not found');
  return campaignSummary(db, id);
}

// -- the collector-wide hold ------------------------------------------------

/** Set when the map provider asked for a human (consent, CAPTCHA): every
 * later search would hit the same wall, so nothing starts until a person
 * clears it in the browser and resumes the collector. */
export function hold(db: DatabaseSync): { reason: string; since: number } | null {
  const row = db.prepare("SELECT value, updated_at FROM collector_state WHERE key='hold'").get() as Row | undefined;
  return row ? { reason: String(row.value), since: Number(row.updated_at) } : null;
}

export function setHold(db: DatabaseSync, reason: string | null, now = Date.now()) {
  if (reason === null) db.prepare("DELETE FROM collector_state WHERE key='hold'").run();
  else
    db.prepare(
      `INSERT INTO collector_state(key, value, updated_at) VALUES ('hold', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(reason, now);
}

// -- scheduling ----------------------------------------------------------------

/** Settle every active item whose job reached an end state. Returns a hold
 * reason when the provider asked for a human. */
export function settleActive(db: DatabaseSync, maxTries: number, now = Date.now()): string | null {
  let holdReason: string | null = null;
  const rows = db
    .prepare(
      `SELECT i.campaign_id, i.position, i.query, i.attempts, i.job_id, c.status AS campaign_status,
              j.id AS jid, j.status, j.error_code, j.result_count
         FROM campaign_items i JOIN campaigns c ON c.id = i.campaign_id
         LEFT JOIN jobs j ON j.id = i.job_id
        WHERE i.status='active'`,
    )
    .all() as Row[];
  const set = db.prepare(
    'UPDATE campaign_items SET status=?, attempts=?, results=?, updated_at=? WHERE campaign_id=? AND position=?',
  );
  transaction(db, () => {
    for (const r of rows) {
      const key = [r.campaign_id, r.position] as const;
      if (!r.jid) {
        // The job was pruned or never existed: search again.
        set.run('pending', r.attempts, 0, now, ...key);
        continue;
      }
      const results = Number(r.result_count ?? 0);
      if (r.status === 'done' || (r.status === 'error' && results > 0)) {
        set.run('done', r.attempts, results, now, ...key);
      } else if (r.status === 'error' && r.error_code === 'human_required') {
        set.run('pending', r.attempts, 0, now, ...key);
        holdReason = `human_required on "${r.query}"`;
      } else if (r.status === 'error') {
        const attempts = Number(r.attempts) + 1;
        set.run(attempts < maxTries ? 'pending' : 'failed', attempts, 0, now, ...key);
      } else if (r.status === 'cancelled') {
        set.run(results > 0 ? 'done' : 'cancelled', r.attempts, results, now, ...key);
      }
    }
    // A running campaign with nothing left is finished.
    db.prepare(
      `UPDATE campaigns SET status='done', updated_at=? WHERE status='running' AND NOT EXISTS (
         SELECT 1 FROM campaign_items i WHERE i.campaign_id = campaigns.id AND i.status IN ('pending','active'))`,
    ).run(now);
  });
  return holdReason;
}

/** Whether a search is in the browser now -- any job, campaign or not. The
 * worker takes one map at a time, and a job's deadline runs from creation,
 * so queueing more behind it only lets them expire. */
export function browserBusy(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM jobs WHERE status='pending' OR (status='running' AND phase IN ('queued','opening_map','scraping')) LIMIT 1`,
      )
      .get(),
  );
}

export function inFlight(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) n FROM campaign_items WHERE status='active'").get() as Row).n);
}

/** The next search: highest priority among running campaigns, and between
 * equals the one that waited longest, so campaigns share the worker. */
export function nextItem(db: DatabaseSync) {
  const row = db
    .prepare(
      `SELECT c.id, c.params, (SELECT MIN(position) FROM campaign_items i
                                WHERE i.campaign_id = c.id AND i.status='pending') AS position
         FROM campaigns c WHERE c.status='running'
        ORDER BY (position IS NULL), c.priority DESC, c.last_submit_at ASC LIMIT 1`,
    )
    .get() as Row | undefined;
  if (!row || row.position === null || row.position === undefined) return null;
  const item = db
    .prepare('SELECT * FROM campaign_items WHERE campaign_id=? AND position=?')
    .get(row.id, row.position) as Row;
  return {
    campaignId: String(row.id),
    position: Number(row.position),
    query: String(item.query),
    attempts: Number(item.attempts),
    params: JSON.parse(String(row.params)) as CampaignParams,
  };
}

export function markSubmitted(
  db: DatabaseSync,
  campaignId: string,
  position: number,
  jobId: string,
  now = Date.now(),
) {
  transaction(db, () => {
    db.prepare(
      "UPDATE campaign_items SET status='active', job_id=?, updated_at=? WHERE campaign_id=? AND position=?",
    ).run(jobId, now, campaignId, position);
    db.prepare('UPDATE campaigns SET last_submit_at=? WHERE id=?').run(now, campaignId);
  });
}

/** Record an item as already done or in flight without running it: used to
 * carry over progress made before campaigns existed. */
export function adoptProgress(
  db: DatabaseSync,
  campaignId: string,
  done: number,
  active: { position: number; jobId: string }[],
  now = Date.now(),
) {
  transaction(db, () => {
    db.prepare(
      "UPDATE campaign_items SET status='done', updated_at=? WHERE campaign_id=? AND position < ? AND status='pending'",
    ).run(now, campaignId, done);
    const set = db.prepare(
      "UPDATE campaign_items SET status='active', job_id=?, updated_at=? WHERE campaign_id=? AND position=?",
    );
    for (const a of active) set.run(a.jobId, now, campaignId, a.position);
  });
}
