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

test('reads the bare-array response Google serves since 2026-11', async () => {
  // No {"d": ...} wrapper any more: the places sit in one top-level block as
  // [header, place], beside a sponsored block that must not be read as results.
  const place = (title: string, id: string) => {
    const record: unknown[] = [];
    record[11] = title;
    record[78] = id;
    record[259] = null;
    return [null, record];
  };
  const sponsored = [[['Sponsored Dental', 'ad']]];
  const fixture: unknown[] = ['Fixture', null, sponsored];
  fixture[64] = [[null, null], [null, null], place('First', 'id-1'), place('Second', 'id-2')];
  vi.stubGlobal('fetch', async () => new Response(`)]}'\n${JSON.stringify(fixture)}`));
  const result = await fetchGoogleMapsResults(query, new AbortController().signal);
  expect(result.data.map(row => row.title)).toEqual(['First', 'Second']);
  expect(result.data[0].maps_url).toContain('query_place_id=id-1');
});

test('reads a d payload that carries its own XSSI prefix', async () => {
  // Since 2026-11 the string in "d" starts with )]}' itself; parsing it raw
  // threw, and every collection ended as map_unavailable.
  const fixture = [[null, [null, entry({ title: 'Prefixed', place: 'p-1' })]]];
  const body = { c: 0, d: `)]}'\n${JSON.stringify(fixture)}` };
  vi.stubGlobal('fetch', async () => new Response(`)]}'\n${JSON.stringify(body)}`));
  const result = await fetchGoogleMapsResults(query, new AbortController().signal);
  expect(result.data.map(row => row.title)).toEqual(['Prefixed']);
});
