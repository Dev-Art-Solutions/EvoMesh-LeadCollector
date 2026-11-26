/**
 * Marketing audits: queued in SQLite, run one at a time by AuditsService,
 * written as report.pdf + report.html + audit.json under the audit
 * directory, and offered to the Data Collector as a marketing_audit record.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { envelope } from '../datacollector/dc-sync';
import { collectEvidence } from './evidence';
import { htmlToPdf } from './pdf';
import { loadBrand, renderReport } from './report';
import { score } from './scoring';

type Row = Record<string, any>;

export class AuditError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export function queueAudit(db: DatabaseSync, leadId: string, requestedBy: string | null, now = Date.now()) {
  if (!db.prepare('SELECT 1 FROM leads WHERE id=?').get(leadId)) throw new AuditError('not_found', 'lead not found');
  const open = db
    .prepare("SELECT id FROM audits WHERE lead_id=? AND status IN ('queued','running')")
    .get(leadId) as Row | undefined;
  if (open) return auditView(db, String(open.id));
  const id = randomUUID();
  db.prepare(
    "INSERT INTO audits(id, lead_id, status, requested_by, created_at) VALUES (?, ?, 'queued', ?, ?)",
  ).run(id, leadId, requestedBy, now);
  return auditView(db, id);
}

/** An audit for a business known only by its website (not collected from a
 * map): reuse a lead with that domain, or record a minimal one. Its listing
 * checks then read "not checked". */
export function queueAuditForWebsite(
  db: DatabaseSync,
  input: { url: string; name?: string; country?: string },
  requestedBy: string | null,
  now = Date.now(),
) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input.url) ? input.url : `https://${input.url}`);
  } catch {
    throw new AuditError('invalid', 'website_url is not a valid address');
  }
  if (!/^https?:$/.test(url.protocol)) throw new AuditError('invalid', 'website_url must be http(s)');
  const domain = url.hostname.replace(/^www\./, '').toLowerCase();
  const existing = db
    .prepare(
      `SELECT id FROM leads WHERE lower(json_extract(profile,'$.domain')) = ?
         ORDER BY CAST(json_extract(profile,'$.review_count') AS INTEGER) DESC LIMIT 1`,
    )
    .get(domain) as Row | undefined;
  let leadId = existing ? String(existing.id) : '';
  if (!leadId) {
    leadId = randomUUID();
    const name = (input.name ?? '').trim() || domain;
    const profile = {
      schema_version: 1,
      id: leadId,
      name,
      website_url: url.href,
      domain,
      ...(input.country ? { country_code: input.country.toUpperCase() } : {}),
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      'INSERT INTO leads(id, fallback_key, name, search_text, profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(leadId, `website:${domain}`, name, `${name} ${domain}`.toLowerCase(), JSON.stringify(profile), now, now);
  }
  return queueAudit(db, leadId, requestedBy, now);
}

export interface BatchFilter {
  city?: string;
  category?: string;
  query?: string;
  withWebsite?: boolean;
  withoutMetaPixel?: boolean;
  limit?: number;
}

const folded = new WeakSet<DatabaseSync>();
/** SQLite's lower() and LIKE fold ASCII only; town and category names are
 * stored in the listing's language ("Велико Търново", "Ресторант"). */
function ensureFold(db: DatabaseSync) {
  if (folded.has(db)) return;
  db.function('fold', { deterministic: true }, (v: unknown) => String(v ?? '').toLocaleLowerCase());
  folded.add(db);
}

/** Leads matching a filter, most-reviewed first, for a batch of audits. */
export function findLeads(db: DatabaseSync, f: BatchFilter) {
  ensureFold(db);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.city) {
    where.push("fold(json_extract(l.profile,'$.city')) = ?");
    args.push(f.city.trim().toLocaleLowerCase());
  }
  if (f.category) {
    where.push("instr(fold(json_extract(l.profile,'$.categories')), ?) > 0");
    args.push(f.category.trim().toLocaleLowerCase());
  }
  if (f.query) {
    where.push('instr(fold(l.search_text), ?) > 0');
    args.push(f.query.trim().toLocaleLowerCase());
  }
  if (f.withWebsite) where.push("json_extract(l.profile,'$.website_url') IS NOT NULL");
  if (f.withoutMetaPixel)
    where.push(`EXISTS (SELECT 1 FROM lead_sources s WHERE s.lead_id = l.id
      AND json_extract(s.evidence,'$.kind')='website_technology'
      AND json_extract(s.evidence,'$.fields.analytics.meta_pixel') = 0)`);
  const limit = Math.max(1, Math.min(200, f.limit ?? 20));
  return db
    .prepare(
      `SELECT l.id, json_extract(l.profile,'$.name') name, json_extract(l.profile,'$.city') city,
              json_extract(l.profile,'$.website_url') website, json_extract(l.profile,'$.review_count') reviews
         FROM leads l ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CAST(json_extract(l.profile,'$.review_count') AS INTEGER) DESC LIMIT ${limit}`,
    )
    .all(...args) as Row[];
}

export function auditView(db: DatabaseSync, id: string) {
  const r = db
    .prepare(
      `SELECT a.*, json_extract(l.profile,'$.name') name, json_extract(l.profile,'$.city') city,
              json_extract(l.profile,'$.website_url') website
         FROM audits a JOIN leads l ON l.id = a.lead_id WHERE a.id=?`,
    )
    .get(id) as Row | undefined;
  if (!r) throw new AuditError('not_found', 'audit not found');
  return {
    id: String(r.id),
    lead_id: String(r.lead_id),
    business: r.name,
    city: r.city,
    website: r.website,
    status: String(r.status),
    language: r.language,
    overall: r.overall,
    summary: r.summary ? JSON.parse(String(r.summary)) : null,
    pdf_path: r.pdf_path,
    json_path: r.json_path,
    error: r.error,
    requested_by: r.requested_by,
    created_at: Number(r.created_at),
    finished_at: r.finished_at ? Number(r.finished_at) : null,
  };
}

export function listAudits(db: DatabaseSync, limit = 50) {
  return (db.prepare('SELECT id FROM audits ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map((r) =>
    auditView(db, String(r.id)),
  );
}

export function claimNext(db: DatabaseSync, now = Date.now()) {
  const row = db
    .prepare("SELECT id, lead_id FROM audits WHERE status='queued' ORDER BY created_at LIMIT 1")
    .get() as Row | undefined;
  if (!row) return null;
  db.prepare("UPDATE audits SET status='running', started_at=? WHERE id=?").run(now, row.id);
  return { id: String(row.id), leadId: String(row.lead_id) };
}

/** An audit left running by a stopped process goes back to the queue. */
export function requeueStale(db: DatabaseSync) {
  db.prepare("UPDATE audits SET status='queued', started_at=NULL WHERE status='running'").run();
}

const slug = (s: string) =>
  s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'business';

/** The PDF as record fields: base64 content plus what a consumer needs to
 * save and check it. */
export function pdfAttachment(pdfPath: string, business: string) {
  const bytes = readFileSync(pdfPath);
  const base = `marketing-audit-${slug(business)}.pdf`;
  return {
    pdf_filename: base,
    pdf_mime: 'application/pdf',
    pdf_encoding: 'base64',
    pdf_bytes: bytes.length,
    pdf_sha256: createHash('sha256').update(bytes).digest('hex'),
    pdf_base64: bytes.toString('base64'),
  };
}

export async function runAudit(
  db: DatabaseSync,
  audit: { id: string; leadId: string },
  directory: string,
  signal: AbortSignal,
  options: { pagespeed?: boolean; dcCollection?: boolean } = {},
) {
  try {
    const evidence = await collectEvidence(db, audit.leadId, signal, { pagespeed: options.pagespeed });
    const result = score(evidence);
    const html = renderReport(evidence, result, loadBrand());
    const day = evidence.generated_at.slice(0, 10);
    const folder = join(directory, `${day}-${slug(evidence.business.name)}-${audit.id.slice(0, 8)}`);
    mkdirSync(folder, { recursive: true });
    const htmlPath = join(folder, 'report.html');
    const pdfPath = join(folder, 'report.pdf');
    const jsonPath = join(folder, 'audit.json');
    writeFileSync(htmlPath, html, 'utf8');
    const { page_text_sample: _sample, ...websiteValue } = evidence.website.value ?? ({} as Row);
    writeFileSync(
      jsonPath,
      JSON.stringify({ ...evidence, website: { ...evidence.website, value: evidence.website.value ? websiteValue : undefined }, score: result }, null, 1),
      'utf8',
    );
    await htmlToPdf(htmlPath, pdfPath);
    const summary = {
      categories: Object.fromEntries(result.categories.map((c) => [c.id, c.score])),
      top_recommendations: result.recommendations.slice(0, 5).map((r) => r.title),
      not_checked: result.criteria.filter((c) => c.status === 'unknown').map((c) => c.id),
    };
    db.prepare(
      `UPDATE audits SET status='done', language=?, overall=?, summary=?, pdf_path=?, json_path=?, finished_at=?, error=NULL WHERE id=?`,
    ).run(evidence.language, result.overall, JSON.stringify(summary), pdfPath, jsonPath, Date.now(), audit.id);
    if (options.dcCollection) {
      const profile = JSON.parse(String((db.prepare('SELECT profile FROM leads WHERE id=?').get(audit.leadId) as Row).profile));
      const businessKey = profile.place_id ? `business:${profile.platform}:${profile.place_id}` : `business:leadcollector:${audit.leadId}`;
      const payload = {
        business_key: businessKey,
        business: evidence.business.name,
        city: evidence.business.city,
        website: evidence.business.website_url,
        overall: result.overall,
        ...summary.categories,
        top_recommendations: summary.top_recommendations,
        not_checked: summary.not_checked,
        language: evidence.language,
        // The report itself travels with the record, so a consumer of the
        // collector gets the PDF and not a path on the auditor's machine.
        // JSON carries no raw bytes: base64 of the PDF (application/pdf).
        ...pdfAttachment(pdfPath, evidence.business.name),
        audited_at: evidence.generated_at,
      };
      const event = envelope('marketing_audit', `marketing_audit:${audit.id}`, payload, {
        observedAt: evidence.generated_at,
        sourceUrl: evidence.business.website_url ?? '',
        privacy: 'business_contact',
      });
      db.prepare(
        `INSERT OR IGNORE INTO dc_outbox(event_id, source_key, content_hash, entity_type, payload, state, attempts, next_attempt_at, last_error, created_at)
         VALUES (?, ?, ?, 'marketing_audit', ?, 'pending', 0, 0, '', ?)`,
      ).run(event.event_id, event.source_key, createHash('sha256').update(JSON.stringify(payload)).digest('hex'), JSON.stringify(event), Date.now());
    }
  } catch (error) {
    db.prepare("UPDATE audits SET status='error', error=?, finished_at=? WHERE id=?").run(
      (error as Error).message.slice(0, 500),
      Date.now(),
      audit.id,
    );
  }
}
