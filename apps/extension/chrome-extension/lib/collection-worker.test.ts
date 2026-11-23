import { describe, expect, it, vi } from 'vitest';
import { CollectionWorker, type CollectionJob, type WorkerPort } from './collection-worker';

const map = 'https://www.google.com/maps/search/shops';
const job: CollectionJob = {
  id: 'collection-1', platform: 'google_maps', query: 'shops', status: 'running', phase: 'opening_map',
  attempt: 1, limit: 3, leaseExpiresAt: 90000, deadlineAt: 300000, scrapedCount: 0,
};
const sender = { tab: { id: 17 }, frameId: 0, documentId: 'document-a', url: map };

function fixture() {
  let time = 1000;
  let active: Awaited<ReturnType<WorkerPort['loadActive']>>;
  let outbox: Awaited<ReturnType<WorkerPort['loadOutbox']>>;
  const tabs = new Map([[42, 'https://personal.example/']]);
  const post = vi.fn<WorkerPort['post']>().mockImplementation(async (_backend, _token, path, body) => {
    if (path === 'next') return { status: 200, job };
    if (path.endsWith('/heartbeat')) return { status: 200, job: { ...job, phase: String(body.phase) } };
    return { status: 200, job: { ...job, status: 'done' } };
  });
  const port: WorkerPort = {
    loadActive: async () => active && structuredClone(active),
    saveActive: async value => { active = value && structuredClone(value); },
    loadOutbox: async () => outbox && structuredClone(outbox),
    saveOutbox: async value => { outbox = value && structuredClone(value); },
    config: async () => ({ backend: 'http://127.0.0.1:5050', workerId: 'worker', token: 'test', version: '1.2.0' }),
    post,
    openPlaceholder: vi.fn(async () => { tabs.set(17, 'chrome-extension://id/collection-tab.html'); return 17; }),
    navigate: async (id, url) => { tabs.set(id, url); },
    tab: async id => tabs.has(id) ? { url: tabs.get(id) } : undefined,
    close: async id => { tabs.delete(id); return true; },
    now: () => time,
  };
  return { port, post, tabs, setTime: (value: number) => { time = value; } };
}

describe('collection worker', () => {
  it('serializes concurrent triggers and recovers its assignment across MV3 suspension', async () => {
    const { port, post, tabs } = fixture();
    const first = new CollectionWorker(port);
    await Promise.all([first.tick(), first.tick()]);
    expect(port.openPlaceholder).toHaveBeenCalledOnce();
    expect(post.mock.calls.filter(call => call[2] === 'next')).toHaveLength(1);
    expect(tabs.get(17)).toBe(map);

    const restarted = new CollectionWorker(port);
    expect(await restarted.ready({ ...sender, tab: { id: 42 } })).toBeNull();
    expect(await restarted.ready(sender)).toEqual({ id: job.id, limit: job.limit });
    expect(await restarted.progress(sender, job.id, 900)).toBe(true);
    await restarted.tick();
    expect(post.mock.calls.at(-1)?.[3]).toMatchObject({ phase: 'scraping', count: 3 });
    expect(port.openPlaceholder).toHaveBeenCalledOnce();
    expect(await restarted.report({ ...sender, documentId: 'other' }, job.id, { endpoint: 'results', body: {} })).toBe(false);
  });

  it('replays the same durable result after a lost response and never closes personal tabs', async () => {
    const { port, post, tabs } = fixture();
    const first = new CollectionWorker(port);
    await first.tick();
    await first.ready(sender);
    post.mockResolvedValueOnce({ status: 0 }).mockResolvedValueOnce({ status: 0 });
    const delivery = { endpoint: 'results' as const, body: { data: [{ title: 'Fixture' }] } };
    expect(await first.report(sender, job.id, delivery)).toBe(true);
    expect(await port.loadOutbox()).toMatchObject({ delivery });
    expect(tabs.has(17)).toBe(true);

    const restarted = new CollectionWorker(port);
    await restarted.tick();
    const uploads = post.mock.calls.filter(call => call[2] === `${job.id}/results`);
    expect(uploads.map(call => call[3])).toEqual([
      { data: [{ title: 'Fixture' }], workerId: 'worker', attempt: 1 },
      { data: [{ title: 'Fixture' }], workerId: 'worker', attempt: 1 },
    ]);
    expect(await port.loadOutbox()).toBeUndefined();
    expect(tabs.has(17)).toBe(false);
    expect(tabs.has(42)).toBe(true);
  });

  it('closes and releases cancelled assignments, and closes on local lease expiry offline', async () => {
    const { port, post, tabs, setTime } = fixture();
    const worker = new CollectionWorker(port);
    await worker.tick();
    post.mockResolvedValueOnce({ status: 200, job: { ...job, status: 'cancelled' } });
    await worker.tick();
    expect(tabs.has(17)).toBe(false);
    expect(post.mock.calls.at(-1)?.[2]).toBe(`${job.id}/release`);

    await worker.tick();
    post.mockResolvedValueOnce({ status: 0 });
    setTime(job.leaseExpiresAt + 1);
    await worker.tick();
    expect(tabs.has(17)).toBe(false);
    expect(tabs.has(42)).toBe(true);
  });

  it('reports a provider challenge without opening a different map tab', async () => {
    const { port, post, tabs } = fixture();
    const worker = new CollectionWorker(port);
    await worker.tick();
    tabs.set(17, 'https://consent.google.com/');
    await worker.tick();
    expect(post.mock.calls.at(-1)?.[3]).toMatchObject({ code: 'human_required' });
    expect(port.openPlaceholder).toHaveBeenCalledOnce();
    expect(tabs.has(42)).toBe(true);
  });
});
