import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stateDirectory } from './collector.config';
import { digest, LeadSnapshot, SCHEMA_VERSION } from './leads';

const columns = [
  'schema_version',
  'id',
  'name',
  'categories',
  'website_url',
  'domain',
  'address',
  'street',
  'municipality',
  'city',
  'region',
  'postal_code',
  'country_code',
  'latitude',
  'longitude',
  'platform',
  'place_id',
  'listing_url',
  'review_url',
  'rating',
  'review_count',
  'opening_hours',
  'contacts',
  'sources',
  'enrichment',
  'created_at',
  'updated_at',
] as const;

function csvValue(value: unknown) {
  if (value == null) return '""';
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe =
    typeof value === 'string' && /^(?:\s*[=+@＝＋＠－-]|[\t\r\n])/u.test(text)
      ? `'${text}`
      : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function writeArtifact(
  db: DatabaseSync,
  jobId: string,
  format: 'csv' | 'json',
  records: LeadSnapshot[],
) {
  const id = randomUUID();
  const generated_at = Date.now();
  const record_count = records.length;
  const root = resolve(
    process.env.LEADCOLLECTOR_EXPORT_DIR || join(stateDirectory(), 'exports'),
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `leads-${jobId}-${id}.${format}`);
  const temp = `${path}.tmp`;
  const content =
    format === 'json'
      ? JSON.stringify(
          {
            schema_version: SCHEMA_VERSION,
            job_id: jobId,
            record_count,
            data: records,
          },
          null,
          2,
        ) + '\n'
      : '\uFEFF' +
        [
          columns.join(','),
          ...records.map((row) =>
            columns.map((key) => csvValue(row[key])).join(','),
          ),
        ].join('\r\n') +
        '\r\n';
  const checksum = digest(content);
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temp, path);
    db.prepare(
      `INSERT INTO export_artifacts(id,job_id,original_job_id,path,format,record_count,checksum,generated_at)
      VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, jobId, jobId, path, format, record_count, checksum, generated_at);
  } catch (error) {
    rmSync(temp, { force: true });
    rmSync(path, { force: true });
    throw error;
  }
  return {
    id,
    job_id: jobId,
    format,
    path,
    record_count,
    checksum,
    generated_at,
    schema_version: SCHEMA_VERSION,
  };
}
