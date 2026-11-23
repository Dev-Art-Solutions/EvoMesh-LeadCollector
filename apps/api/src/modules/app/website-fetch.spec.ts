import { AppService, parseContactPage } from './app.service';
import { publicAddress, WebsiteSession, websiteTarget } from './website-fetch';

test.each([
  'localhost',
  'http://127.0.0.1',
  'http://2130706433',
  'http://[::ffff:127.0.0.1]',
  'http://169.254.169.254',
  'http://credentials@example.com',
  'ftp://example.com',
  'http://example.com:8080',
])('rejects invalid, nonpublic, or non-web target %s', (value) => {
  expect(() => websiteTarget(value)).toThrow();
});

test.each([
  '127.0.0.1',
  '172.16.1.1',
  '192.168.1.1',
  '100.64.0.1',
  '10.10.10.10',
  '169.254.169.254',
  '::ffff:10.0.0.1',
  'fe80::1',
  'fc00::1',
  '::1',
  '2001:db8::1',
])('blocks nonpublic DNS answers %s', (address) => {
  expect(publicAddress(address)).toBe(false);
});

test('accepts global addresses and applies robots and same-site redirects per target', async () => {
  expect(publicAddress('1.1.1.1')).toBe(true);
  expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  const url = new URL('https://example.com/');
  const request = jest.fn(async (target: URL) => {
    const base = { type: 'text/html', body: '' };
    if (target.pathname === '/robots.txt')
      return {
        ...base,
        status: 200,
        body: 'User-agent: *\nDisallow: /private',
      };
    if (target.pathname === '/')
      return { ...base, status: 302, location: '/private' };
    return { ...base, status: 200 };
  });
  const session = new WebsiteSession(
    url,
    new AbortController().signal,
    request,
  );
  await expect(session.page(url)).rejects.toThrow('robots_policy');
  expect(request.mock.calls.map(([target]) => target.pathname)).toEqual([
    '/robots.txt',
    '/',
  ]);
  expect(
    session.contactLink(['https://other.example/contact', '/about'], url)?.href,
  ).toBe('https://example.com/about');
});

test('stops before following a redirect off the configured site', async () => {
  const url = new URL('https://example.com/');
  const request = jest.fn(async (target: URL) => ({
    status: target.pathname === '/robots.txt' ? 404 : 302,
    location: 'http://127.0.0.1/',
    body: '',
    type: 'text/html',
  }));
  await expect(
    new WebsiteSession(url, new AbortController().signal, request).page(url),
  ).rejects.toThrow('non_public_target');
  expect(request).toHaveBeenCalledTimes(2);
});

test('parses observed shared contacts from HTML while excluding personal addresses and challenges', () => {
  const url = 'https://example.com/contact';
  const html =
    '<a href="mailto:sales@fixture-business.test">Sales</a><a href="mailto:alice@fixture-business.test">Alice</a>';
  expect(parseContactPage(url, html)).toMatchObject({
    url,
    emails: ['sales@fixture-business.test'],
  });
  expect(() =>
    parseContactPage(url, '<form id="challenge-form"></form>'),
  ).toThrow('human_required');
});

test('stops queuing website requests when the batch is cancelled', async () => {
  const controller = new AbortController();
  const service = new AppService();
  const extract = jest
    .spyOn(service, 'extractWebsite')
    .mockImplementation(async ({ url }, signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return {
        url,
        status: 'unavailable',
        emails: [],
        phones: [],
        socials: [],
      };
    });
  const urls = Array.from(
    { length: 10 },
    (_, index) => `https://example.com/${index}`,
  );
  await service.extractWebsites({ urls }, controller.signal);
  expect(extract.mock.calls.length).toBeGreaterThan(0);
  expect(extract.mock.calls.length).toBeLessThan(urls.length);
});
