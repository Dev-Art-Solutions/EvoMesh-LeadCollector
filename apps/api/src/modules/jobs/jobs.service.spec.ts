import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobsService } from './jobs.service';
import { digest } from './leads';

const source = {
  title: 'Müller & Söhne',
  place_id: 'branch-a',
  address: 'Torstraße 10, Berlin',
  city: 'Berlin',
  country_code: 'DE',
  website: 'https://www.example.com/',
  maps_url: 'https://www.google.com/maps?cid=42',
  phone: '030 123456',
  email: 'info@example.com',
  emails: ['named.person@example.com'],
  rating: 4.6,
  review_count: 12,
  opening_hours: 'Monday: 9–5',
};
const google = {
  platform: 'google_maps' as const,
  query: 'agencies in Berlin',
};
const assignment = { workerId: 'chrome-a', attempt: 1 };
let state: string;
let service: JobsService;
const previousEnv = process.env;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'leadcollector-'));
  process.env = {
    ...previousEnv,
    LEADCOLLECTOR_STATE_DIR: state,
    LEADCOLLECTOR_MAX_PENDING: '2',
  };
  service = new JobsService();
});

afterEach(() => {
  service.onModuleDestroy();
  process.env = previousEnv;
  jest.restoreAllMocks();
  rmSync(state, { recursive: true, force: true });
});

test('lease and job records survive reopen; submission is replayable and stale writes fail', () => {
  const first = service.create({ ...google, limit: 3, requestId: 'request-1' });
  expect(
    service.create({ ...google, limit: 3, requestId: 'request-1' }).id,
  ).toBe(first.id);
  expect(() =>
    service.create({ ...google, limit: 4, requestId: 'request-1' }),
  ).toThrow('Request ID');
  expect(service.claim('chrome-a', '1.2.0')).toMatchObject({
    id: first.id,
    attempt: 1,
  });
  expect(service.claim('chrome-a', '1.2.0')?.id).toBe(first.id);
  expect(service.claim('chrome-b', '1.2.0')).toBeNull();

  service.onModuleDestroy();
  service = new JobsService();
  expect(service.heartbeat(first.id, assignment, 'scraping', 1)).toMatchObject({
    scrapedCount: 1,
    phase: 'scraping',
  });
  const rows = [
    source,
    source,
    { ...source, place_id: 'branch-b', address: 'Torstraße 11, Berlin' },
  ];
  expect(service.submit(first.id, assignment, rows)).toMatchObject({
    status: 'done',
    results: 2,
    scrapedCount: 3,
  });
  expect(service.submit(first.id, assignment, rows).results).toBe(2);
  expect(() => service.submit(first.id, assignment, [])).toThrow(
    'no longer active',
  );
  expect(() =>
    service.submit(first.id, { ...assignment, attempt: 0 }, rows),
  ).toThrow('Stale');
  const page = service.results(first.id, { limit: 1 });
  expect(page.next_cursor).toBe(1);
  expect(page.data[0]).toMatchObject({
    schema_version: 1,
    domain: 'example.com',
    rating: 4.6,
    contacts: expect.arrayContaining([
      expect.objectContaining({ normalized: 'info@example.com' }),
    ]),
    sources: [
      expect.objectContaining({ url: source.maps_url, kind: 'listing' }),
    ],
  });
  expect(JSON.stringify(page)).not.toContain('named.person');
  const second = service.results(first.id, { cursor: page.next_cursor });
  expect(second.data[0].id).not.toBe(page.data[0].id);
  expect(second.next_cursor).toBeNull();

  const cross = service.create({
    platform: 'yandex_maps',
    query: google.query,
  });
  service.claim('chrome-a', '1.2.0');
  service.submit(cross.id, assignment, [{ ...source, place_id: 'yandex-1' }]);
  expect(service.results(cross.id, {}).data[0].id).toBe(page.data[0].id);
  expect(service.search({ query: 'MÜLLER' }).data).toHaveLength(2);
});

test('expired leases retry once and cannot overwrite a newer claim', () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  const job = service.create(google);
  service.claim('chrome-a', '1');
  clock.mockReturnValue(190001);
  expect(service.claim('chrome-b', '1')).toMatchObject({
    id: job.id,
    attempt: 2,
  });
  expect(() => service.submit(job.id, assignment, [source])).toThrow('Stale');
  clock.mockReturnValue(280002);
  expect(() => service.heartbeat(job.id, assignment, 'scraping', 0)).toThrow(
    'Stale',
  );
  expect(service.status(job.id)).toMatchObject({
    errorCode: 'worker_lost',
    status: 'error',
  });
});

test('deadline, queue limit, cancellation and tab release are enforced', () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  const first = service.create(google);
  const second = service.create({ ...google, timeoutSeconds: 30 });
  expect(() => service.create(google)).toThrow('queue is full');
  service.claim('chrome-a', '1');
  expect(service.cancel(first.id).status).toBe('cancelled');
  expect(service.cancel(first.id).status).toBe('cancelled');
  expect(() => service.submit(first.id, assignment, [source])).toThrow(
    'no longer active',
  );
  expect(service.claim('chrome-b', '1')).toBeNull();
  expect(service.heartbeat(first.id, assignment, 'scraping', 1).status).toBe(
    'cancelled',
  );
  service.release(first.id, assignment);
  expect(service.claim('chrome-b', '1')?.id).toBe(second.id);
  clock.mockReturnValue(130001);
  expect(service.status(second.id)).toMatchObject({
    errorCode: 'deadline_exceeded',
    status: 'error',
  });
});

test('oversized submissions and spoofed map URLs are refused', () => {
  expect(() =>
    service.create({
      ...google,
      url: 'https://www.google.com.example/maps/search/coffee',
    }),
  ).toThrow('HTTPS map search URL');
  const job = service.create({ ...google, limit: 1 });
  service.claim('chrome-a', '1');
  expect(() => service.submit(job.id, assignment, [source, source])).toThrow(
    'exceeds requested',
  );
  expect(service.status(job.id).status).toBe('running');
});

test('enrichment is restartable and preserves exact source and partial results', () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  const job = service.create({
    ...google,
    extractContacts: true,
    enrichmentLimit: 2,
  });
  service.claim('chrome-a', '1');
  service.submit(job.id, assignment, [source]);
  const old = service.nextEnrichment();
  expect(old).toMatchObject({ jobId: job.id });
  service.onModuleDestroy();
  service = new JobsService();
  expect(service.nextEnrichment()).toBeUndefined();
  clock.mockReturnValue(120001);
  const task = service.nextEnrichment();
  service.finishEnrichment(old, {
    url: source.website,
    status: 'blocked',
    emails: [],
    socials: [],
    phones: [],
  });
  expect(service.status(job.id)).toMatchObject({
    phase: 'enriching',
    results: 1,
    enrichment: { queued: 1 },
  });
  const contact = 'https://www.example.com/contact';
  service.finishEnrichment(task, {
    url: source.website,
    status: 'found',
    emails: ['sales@example.com'],
    socials: [],
    phones: [],
    pages: [
      { url: contact, emails: ['sales@example.com'], socials: [], phones: [] },
    ],
    attempted_urls: [contact],
  });
  expect(service.status(job.id)).toMatchObject({
    status: 'done',
    results: 1,
    enrichment: { found: 1 },
  });
  expect(service.results(job.id, {}).data[0].contacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        normalized: 'sales@example.com',
        source_url: contact,
      }),
    ]),
  );

  const cancelled = service.create({ ...google, extractContacts: true });
  service.claim('chrome-a', '1');
  service.submit(cancelled.id, assignment, [source]);
  const inFlight = service.nextEnrichment();
  service.cancel(cancelled.id);
  service.finishEnrichment(inFlight, {
    url: contact,
    status: 'failed',
    emails: [],
    socials: [],
    phones: [],
  });
  expect(service.status(cancelled.id)).toMatchObject({
    status: 'cancelled',
    results: 1,
    enrichment: { cancelled: 1 },
  });
});

test('CSV and JSON export Unicode, escape formulas, and outlive retention', () => {
  process.env.LEADCOLLECTOR_JOB_RETENTION_DAYS = '1';
  service.onModuleDestroy();
  service = new JobsService();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(100000);
  const job = service.create(google);
  service.claim('chrome-a', '1');
  const records = Array.from({ length: 200 }, (_, i) => ({
    ...source,
    place_id: String(i + 1),
    title: i === 0 ? '=HYPERLINK("Müller")' : 'Müller',
  }));
  service.submit(job.id, assignment, records);
  const csv = service.export(job.id, 'csv');
  const json = service.export(job.id, 'json');
  expect(csv.record_count).toBe(200);
  const content = readFileSync(csv.path, 'utf8');
  expect(content).toContain('"\'=HYPERLINK(""Müller"")"');
  expect(digest(content)).toBe(csv.checksum);
  expect(JSON.parse(readFileSync(json.path, 'utf8')).data).toHaveLength(200);
  clock.mockReturnValue(100000 + 86400001);
  expect(service.list()).toHaveLength(0);
  expect(readFileSync(csv.path, 'utf8')).toBe(content);
});

test('two jobs are enriched side by side, each one site at a time', () => {
  jest.spyOn(Date, 'now').mockReturnValue(100000);
  const other = { ...source, place_id: 'branch-b', website: 'https://www.example.org/' };
  const first = service.create({ ...google, extractContacts: true });
  service.claim('chrome-a', '1');
  service.submit(first.id, assignment, [source, other]);
  // The browser slot is free once a job is enriching, so the next map job runs.
  const second = service.create({ ...google, query: 'agencies in Hamburg', extractContacts: true });
  expect(service.claim('chrome-a', '1')).toMatchObject({ id: second.id });
  service.submit(second.id, assignment, [source]);
  const a = service.nextEnrichment();
  const b = service.nextEnrichment();
  expect([a?.jobId, b?.jobId].sort()).toEqual([first.id, second.id].sort());
  // The first job still has a queued site, but its lease is taken.
  expect(service.nextEnrichment()).toBeUndefined();
});
