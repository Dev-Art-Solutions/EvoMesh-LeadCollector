import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { JobsService } from '../jobs/jobs.service';
import {
  dcSettings,
  businessRecord,
  chunkBySize,
  enqueueFinishedJobs,
  envelope,
  flatRecord,
  outboxCounts,
  syncOnce,
} from './dc-sync';

const row = {
  title: 'Bakery Sofia',
  place_id: 'place-1',
  address: 'Vitosha 1, Sofia',
  city: 'Sofia',
  country_code: 'BG',
  website: 'https://bakery.example/',
  maps_url: 'https://www.google.com/maps?cid=1',
  phone: '+359 2 123 456',
  email: 'info@bakery.example',
  rating: 4.5,
  review_count: 20,
};
const assignment = { workerId: 'chrome-a', attempt: 1 };
const previousEnv = process.env;
let state: string;
let service: JobsService;
let db: DatabaseSync;

const settings = () =>
  dcSettings({
    LEADCOLLECTOR_DC_URL: 'https://dc.test/api/v1',
    LEADCOLLECTOR_DC_API_KEY: 'k',
    LEADCOLLECTOR_DC_COLLECTION_BUSINESS: 'biz',
    LEADCOLLECTOR_DC_COLLECTION_CONTACT: 'contacts',
    LEADCOLLECTOR_DC_COLLECTION_OBSERVATION: 'obs',
    LEADCOLLECTOR_DC_COLLECTION_RUN: 'runs',
  })!;

function finishedJob() {
  const job = service.create({
    platform: 'google_maps',
    query: 'bakeries in Sofia',
  });
  service.claim('chrome-a', '1');
  service.submit(job.id, assignment, [
    row,
    { ...row, place_id: 'place-2', title: 'Second' },
  ]);
  return job;
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'leadcollector-dc-'));
  process.env = { ...previousEnv, LEADCOLLECTOR_STATE_DIR: state };
  service = new JobsService();
  db = new DatabaseSync(join(state, 'collector.sqlite'));
});

afterEach(() => {
  db.close();
  service.onModuleDestroy();
  process.env = previousEnv;
  rmSync(state, { recursive: true, force: true });
});

test('off without a URL and key; https required', () => {
  expect(dcSettings({})).toBeNull();
  expect(() =>
    dcSettings({
      LEADCOLLECTOR_DC_URL: 'http://x',
      LEADCOLLECTOR_DC_API_KEY: 'k',
    }),
  ).toThrow('https');
});

test('a finished job is exported once, and a re-run only finds duplicates', () => {
  finishedJob();
  const queued = enqueueFinishedJobs(db);
  expect(queued).toBeGreaterThanOrEqual(4); // 2 businesses + contacts + observations + 1 run
  expect(enqueueFinishedJobs(db)).toBe(0);
  db.exec('DELETE FROM dc_exported_jobs');
  expect(enqueueFinishedJobs(db)).toBe(0); // same content, same source_key: duplicates
  const types = db
    .prepare('SELECT DISTINCT entity_type AS t FROM dc_outbox')
    .all() as { t: string }[];
  expect(types.map((t) => t.t).sort()).toEqual([
    'agent_run',
    'business',
    'contact',
    'source_observation',
  ]);
});

test('offline, then online: everything delivered once, keyed by event id', async () => {
  finishedJob();
  enqueueFinishedJobs(db);
  const total = Object.values(outboxCounts(db)).reduce((a, b) => a + b, 0);
  const offline = jest.fn(async () => {
    throw new Error('ECONNREFUSED');
  });
  await syncOnce(db, settings(), offline as never, 1000);
  expect(outboxCounts(db).retry).toBe(Math.min(total, 200));

  const seen = new Map<string, string>();
  const online = jest.fn(async (url: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)['Idempotency-Key'];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k');
    seen.set(key, url);
    return new Response(JSON.stringify({ id: key }), { status: 201 });
  });
  await syncOnce(db, settings(), online as never, Date.now() + 10_000_000);
  expect(outboxCounts(db)).toEqual({ acknowledged: total });
  expect(seen.size).toBe(total);
  expect(
    [...seen.values()].some((url) => url.endsWith('/collections/biz/records')),
  ).toBe(true);
});

test('a rejected key keeps events; a schema error is a dead letter', async () => {
  finishedJob();
  enqueueFinishedJobs(db);
  const report = await syncOnce(
    db,
    settings(),
    (async () => new Response('', { status: 401 })) as never,
    1,
  );
  expect(report.error).toContain('credential rejected');
  expect(outboxCounts(db).dead_letter).toBeUndefined();
  await syncOnce(
    db,
    settings(),
    (async () => new Response('bad', { status: 422 })) as never,
    Date.now() + 10_000_000,
  );
  expect(outboxCounts(db).dead_letter).toBeGreaterThan(0);
});

test('a plain create stores the payload fields at the top of the record', () => {
  const event = envelope('business', 'business:google_maps:x', { name: 'Acme', phone: '1' });
  const record = flatRecord(event);
  expect(record.name).toBe('Acme');
  expect((record.dc_event as Record<string, unknown>).source_key).toBe('business:google_maps:x');
  expect('payload' in (record.dc_event as Record<string, unknown>)).toBe(false);
});

test('plain batch sends many records per request and settles each by its own result', async () => {
  finishedJob();
  enqueueFinishedJobs(db);
  const batch = { ...settings(), plainBatch: true, batchSize: 500 };
  const calls: { url: string; items: unknown[] }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const items = JSON.parse(String(init.body)).items as unknown[];
    calls.push({ url, items });
    // The collector refuses the first item of the business batch only.
    const results = items.map((_, index) =>
      url.includes('/biz/') && index === 0
        ? { index, status: 'error', error: 'schema' }
        : { index, status: 'created', id: `r${index}` },
    );
    return new Response(JSON.stringify({ items: results }), { status: url.includes('/biz/') ? 207 : 201 });
  };
  const report = await syncOnce(db, batch, fetchImpl);
  // One request per collection, not one per record.
  expect(calls.every((call) => call.url.endsWith('/records/batch'))).toBe(true);
  expect(new Set(calls.map((call) => call.url)).size).toBe(calls.length);
  expect(report.dead).toBe(1);
  expect(report.acknowledged).toBe(calls.reduce((n, call) => n + call.items.length, 0) - 1);
  expect((calls.find((call) => call.url.includes('/biz/'))!.items[0] as Record<string, unknown>).dc_event).toBeDefined();
});

test('plain batch stops the round on 429 and keeps every event', async () => {
  finishedJob();
  const queued = enqueueFinishedJobs(db);
  let requests = 0;
  const report = await syncOnce(db, { ...settings(), plainBatch: true }, async () => {
    requests++;
    return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  });
  expect(requests).toBe(1);
  expect(report.acknowledged).toBe(0);
  // The refused chunk waits for its retry; collections not tried stay pending.
  const counts = outboxCounts(db);
  expect(counts.retry).toBeGreaterThan(0);
  expect((counts.retry ?? 0) + (counts.pending ?? 0)).toBe(queued);
});

test('an entity is queued once however many jobs see it', () => {
  finishedJob();
  const first = enqueueFinishedJobs(db);
  finishedJob(); // the same two places, found by a second search
  const second = enqueueFinishedJobs(db);
  expect(first).toBeGreaterThan(1);
  // Only the second job's run record is new.
  expect(second).toBe(1);
  const keys = db
    .prepare("SELECT source_key, COUNT(*) n FROM dc_outbox WHERE entity_type <> 'agent_run' GROUP BY source_key HAVING n > 1")
    .all();
  expect(keys).toEqual([]);
});

test('the business record carries the lead contacts and whether it has a website', () => {
  const contacts = [
    { type: 'phone', normalized: '+15550001', source_url: 'https://site.example/contact' },
    { type: 'phone', normalized: '+15550002', source_url: 'https://www.google.com/maps?cid=1' },
    { type: 'email', normalized: 'info@site.example', source_url: 'https://site.example/' },
    { type: 'email', normalized: 'info@site.example', source_url: 'https://site.example/contact' },
    { type: 'social', normalized: 'https://facebook.com/site', source_url: 'https://site.example/' },
  ];
  const withSite = businessRecord({ name: 'A', website_url: 'https://site.example/' }, contacts);
  expect(withSite).toMatchObject({
    has_website: true,
    phone: '+15550002',
    email: 'info@site.example',
    emails: ['info@site.example'],
    phones: ['+15550001', '+15550002'],
    socials: ['https://facebook.com/site'],
  });
  expect(businessRecord({ name: 'B' }, [])).toMatchObject({ has_website: false, phone: null, email: null });
});

test('a batch is cut by size as well as count, so a record carrying a PDF fits', () => {
  const row = (kb: number) => ({ payload: 'x'.repeat(kb * 1024) });
  const rows = [row(1500), row(1500), row(1500), row(10), row(5000)];
  const chunks = chunkBySize(rows, 500, 4 * 1024 * 1024);
  expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  expect(chunkBySize([row(1), row(1), row(1)], 2, 1024 * 1024).map((c) => c.length)).toEqual([2, 1]);
});
