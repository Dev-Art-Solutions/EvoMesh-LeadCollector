import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { JobsService } from '../jobs/jobs.service';
import {
  dcSettings,
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
