import { afterEach, expect, test, vi } from 'vitest';
import { fetchGoogleMapsResults, getGoogleMapsConfig } from './extract';

const query = {
  search: 'Fixture', lat: 0, long: 0, alt: 100, page: 2, psi: '',
  language: 'en', region: '', width: 1280, height: 800, take: 20,
};
const entry = ({ title, cid, place }: { title?: string; cid?: string; place?: string }) => {
  const record: unknown[] = [];
  record[10] = cid;
  record[11] = title;
  record[78] = place;
  const wrapper: unknown[] = [];
  wrapper[14] = record;
  return wrapper;
};

afterEach(() => vi.unstubAllGlobals());

test('reads a map page with missing optional IDs and uses the next zero-based offset', async () => {
  const fixture = [[null, [
    null, entry({ title: 'Müller', cid: '0x1:0x2a' }), entry({}),
    entry({ title: 'Second branch', place: 'fixture-id' }),
  ]]];
  const fetch = vi.fn(async (_url: string) => new Response(`)]}'\n${JSON.stringify({ d: JSON.stringify(fixture) })}`));
  vi.stubGlobal('fetch', fetch);
  const result = await fetchGoogleMapsResults(query, new AbortController().signal);
  expect(result.data.map(row => row.title)).toEqual(['Müller', 'Second branch']);
  expect(result.data[0].maps_url).toBe('https://www.google.com/maps?cid=42');
  expect(result.data[1].maps_url).toContain('query_place_id=fixture-id');
  expect(new URL(fetch.mock.calls[0][0]).searchParams.get('pb')).toContain('!8i20');
});

test('reports a throttled map request instead of returning a successful empty result', async () => {
  vi.stubGlobal('fetch', async () => new Response('', { status: 429 }));
  await expect(fetchGoogleMapsResults(query, new AbortController().signal))
    .rejects.toMatchObject({ code: 'human_required' });
});

test('accepts coordinates on zero latitude or longitude from the map search URL', async () => {
  vi.stubGlobal('location', { href: 'https://www.google.com/maps/search/Fixture/@0,12.5,11z' });
  await expect(getGoogleMapsConfig()).resolves.toMatchObject({ search: 'Fixture', lat: 0, long: 12.5 });
});
