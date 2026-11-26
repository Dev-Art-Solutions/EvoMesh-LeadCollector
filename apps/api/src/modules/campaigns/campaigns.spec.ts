import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { JobsService } from '../jobs/jobs.service';
import {
  adoptProgress,
  browserBusy,
  campaignDetail,
  changeCampaign,
  createCampaign,
  hold,
  inFlight,
  listCampaigns,
  mapsSearchUrl,
  markSubmitted,
  nextItem,
  settleActive,
} from './campaigns';
import { CATEGORY_PRESETS } from './presets';

const previousEnv = process.env;
let state: string;
let service: JobsService;
let db: DatabaseSync;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'leadcollector-campaigns-'));
  process.env = { ...previousEnv, LEADCOLLECTOR_STATE_DIR: state, LEADCOLLECTOR_MAX_PENDING: '50' };
  service = new JobsService();
  db = new DatabaseSync(join(state, 'collector.sqlite'));
});

afterEach(() => {
  db.close();
  service.onModuleDestroy();
  process.env = previousEnv;
  rmSync(state, { recursive: true, force: true });
});

/** Submit the scheduler's next pick as a real job, the way the service does. */
function submitNext() {
  const next = nextItem(db)!;
  const job = service.create({
    platform: 'google_maps',
    query: next.query,
    url: mapsSearchUrl(next.query, next.params),
    owner: `campaign:${next.campaignId}`,
  });
  markSubmitted(db, next.campaignId, next.position, job.id);
  return { next, job };
}

test('a campaign is every category in every location, a location at a time', () => {
  const c = createCampaign(db, {
    name: 'Veliko Tarnovo restaurants and cafes',
    locations: ['Veliko Tarnovo, Bulgaria', 'Gorna Oryahovitsa, Bulgaria'],
    categories: ['restaurants', 'cafes'],
    country: 'BG',
  });
  expect(c).toMatchObject({ status: 'running', country: 'bg', language: 'bg', searches: { total: 4, pending: 4 } });
  const first = nextItem(db)!;
  expect(first.query).toBe('restaurants in Veliko Tarnovo, Bulgaria');
  expect(mapsSearchUrl(first.query, first.params)).toBe(
    'https://www.google.com/maps/search/restaurants%20in%20Veliko%20Tarnovo%2C%20Bulgaria?hl=bg&gl=bg',
  );
  expect(createCampaign(db, { name: 'all', locations: ['X'], preset: 'all_local' }).searches.total).toBe(
    CATEGORY_PRESETS.all_local.length,
  );
});

test('a higher-priority campaign goes first; equals take turns', () => {
  const usa = createCampaign(db, { name: 'USA', locations: ['A, TX', 'B, TX'], categories: ['dentists'] });
  const vt = createCampaign(db, { name: 'VT', locations: ['Veliko Tarnovo'], categories: ['cafes', 'bars'], priority: 10 });
  expect(nextItem(db)!.campaignId).toBe(vt.id);
  markSubmitted(db, vt.id, 0, '00000000-0000-4000-8000-000000000001', 1000);
  expect(nextItem(db)!.campaignId).toBe(vt.id);
  // Equal priority: the one that waited longest.
  changeCampaign(db, vt.id, 'pause');
  const other = createCampaign(db, { name: 'Other', locations: ['C, TX'], categories: ['dentists'] });
  markSubmitted(db, usa.id, 0, '00000000-0000-4000-8000-000000000002', 2000);
  expect(nextItem(db)!.campaignId).toBe(other.id);
});

test('finished jobs settle their searches; failures retry, then fail', () => {
  const c = createCampaign(db, { name: 'T', locations: ['Town'], categories: ['dentists', 'lawyers'] });
  const { job } = submitNext();
  expect(inFlight(db)).toBe(1);
  expect(browserBusy(db)).toBe(true);
  db.prepare("UPDATE jobs SET status='done', phase='done', result_count=42 WHERE id=?").run(job.id);
  expect(settleActive(db, 2)).toBeNull();
  expect(campaignDetail(db, c.id)).toMatchObject({ searches: { done: 1, pending: 1 }, leads: 42 });

  const second = submitNext();
  db.prepare("UPDATE jobs SET status='error', phase='error', error_code='map_unavailable' WHERE id=?").run(second.job.id);
  settleActive(db, 2);
  expect(campaignDetail(db, c.id).searches.pending).toBe(1); // one retry left
  const third = submitNext();
  expect(third.next.attempts).toBe(1);
  db.prepare("UPDATE jobs SET status='error', phase='error', error_code='map_unavailable' WHERE id=?").run(third.job.id);
  settleActive(db, 2);
  expect(campaignDetail(db, c.id)).toMatchObject({ status: 'done', searches: { done: 1, failed: 1 } });
});

test('a human-required answer holds everything and keeps the search', () => {
  const c = createCampaign(db, { name: 'T', locations: ['Town'], categories: ['dentists'] });
  const { job } = submitNext();
  db.prepare("UPDATE jobs SET status='error', phase='error', error_code='human_required' WHERE id=?").run(job.id);
  expect(settleActive(db, 2)).toContain('human_required');
  expect(campaignDetail(db, c.id).searches).toMatchObject({ pending: 1, failed: 0 });
  expect(hold(db)).toBeNull(); // the service records it; settle only reports it
});

test('pause starts nothing new, stop cancels, resume brings stopped searches back', () => {
  const c = createCampaign(db, { name: 'T', locations: ['Town'], categories: ['a', 'b', 'c'] });
  const { job } = submitNext();
  changeCampaign(db, c.id, 'pause');
  expect(nextItem(db)).toBeNull();
  expect(() => changeCampaign(db, c.id, 'pause')).toThrow('paused');
  changeCampaign(db, c.id, 'resume');
  const { cancel } = changeCampaign(db, c.id, 'stop');
  expect(cancel).toEqual([job.id]);
  expect(campaignDetail(db, c.id)).toMatchObject({ status: 'stopped', searches: { cancelled: 3 } });
  changeCampaign(db, c.id, 'resume');
  expect(campaignDetail(db, c.id)).toMatchObject({ status: 'running', searches: { pending: 3 } });
  expect(listCampaigns(db)).toHaveLength(1);
});

test('progress made before campaigns existed can be adopted', () => {
  const c = createCampaign(db, { name: 'USA', locations: ['A', 'B', 'C'], categories: ['x', 'y'] });
  adoptProgress(db, c.id, 4, [{ position: 4, jobId: '00000000-0000-4000-8000-000000000009' }]);
  expect(campaignDetail(db, c.id).searches).toMatchObject({ done: 4, active: 1, pending: 1 });
  expect(nextItem(db)!.position).toBe(5);
});
