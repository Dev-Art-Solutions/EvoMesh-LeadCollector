import { Resolver, lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import * as ipaddr from 'ipaddr.js';
import robotsParser = require('robots-parser');

const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
export const CRAWLER = 'EvoMesh-LeadCollector';
const IPV6_GLOBAL = ipaddr.parse('2000::');

export class WebsiteError extends Error {
  constructor(
    public readonly status: 'blocked' | 'unavailable' | 'failed',
    public readonly code: string,
  ) {
    super(code);
  }
}

export function websiteTarget(value: string): URL {
  if (value.length > 2048) throw new WebsiteError('blocked', 'invalid_url');
  let url: URL;
  try {
    url = new URL(/^[a-z][\w+.-]*:/i.test(value) ? value : `https://${value}`);
  } catch {
    throw new WebsiteError('blocked', 'invalid_url');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    !url.hostname.includes('.') ||
    /(?:^|\.)(localhost|local|internal|lan|home\.arpa)\.?$/i.test(url.hostname)
  ) {
    throw new WebsiteError('blocked', 'non_public_target');
  }
  url.hash = '';
  return url;
}

export function publicAddress(value: string): boolean {
  try {
    const address = ipaddr.process(value);
    return (
      address.range() === 'unicast' &&
      (address.kind() === 'ipv4' || address.match(IPV6_GLOBAL, 3))
    );
  } catch {
    return false;
  }
}

const site = (url: URL) =>
  url.hostname
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
type Response = {
  status: number;
  location?: string;
  type: string;
  body: string;
  /** A few response headers a site scan reads (server, HSTS, platform hints). */
  headers?: Record<string, string>;
  /** Time to the whole body, for the scan's load-time observation. */
  elapsedMs?: number;
};

const KEPT_HEADERS = ['server', 'x-powered-by', 'strict-transport-security', 'x-generator', 'x-wix-request-id', 'x-shopify-stage'];

async function osAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<{ address: string; family: 4 | 6 }[]> {
  signal.throwIfAborted();
  try {
    const found = await lookup(hostname, { all: true, verbatim: true });
    return found
      .filter(({ family }) => family === 4 || family === 6)
      .map(({ address, family }) => ({ address, family: family as 4 | 6 }));
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

async function requestPinned(url: URL, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const abort = () => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  const missing = (error: NodeJS.ErrnoException): string[] => {
    signal.throwIfAborted();
    if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
    throw new WebsiteError('unavailable', 'dns_unavailable');
  };
  let addresses: { address: string; family: 4 | 6 }[];
  try {
    const [ipv4, ipv6] = await Promise.all([
      resolver.resolve4(url.hostname).catch(missing),
      resolver.resolve6(url.hostname).catch(missing),
    ]);
    addresses = [
      ...ipv4.map((address) => ({ address, family: 4 as const })),
      ...ipv6.map((address) => ({ address, family: 6 as const })),
    ];
  } catch (error) {
    // The resolver's server list can be unusable while the OS resolves fine:
    // on Windows it reads 127.0.0.1 when a local DNS proxy fronts the
    // adapter, and every query was refused -- every site "dns_unavailable".
    // The answer is still checked against publicAddress below and pinned.
    if (!(error instanceof WebsiteError)) throw error;
    addresses = await osAddresses(url.hostname, signal);
  } finally {
    resolver.cancel();
    signal.removeEventListener('abort', abort);
  }
  if (!addresses.length)
    throw new WebsiteError('unavailable', 'dns_unavailable');
  if (addresses.some(({ address }) => !publicAddress(address))) {
    throw new WebsiteError('blocked', 'non_public_dns');
  }
  signal.throwIfAborted();
  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        signal,
        agent: false,
        family: pinned.family,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        headers: {
          'User-Agent': CRAWLER,
          'Accept-Encoding': 'identity',
          Accept: 'text/html, text/plain, application/xhtml+xml',
        },
      },
      (response) => {
        const status = response.statusCode ?? 502;
        const headers: Record<string, string> = {};
        for (const name of KEPT_HEADERS) {
          const value = response.headers[name];
          if (value) headers[name] = String(Array.isArray(value) ? value[0] : value).slice(0, 200);
        }
        const type = response.headers['content-type'] ?? '';
        const location = response.headers.location;
        if (status >= 300) {
          resolve({ status, location, type, body: '' });
          response.destroy();
          return;
        }
        if (
          !/^\s*(?:text\/html|text\/plain|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(
            type,
          ) &&
          !(url.pathname === '/robots.txt' && !type)
        ) {
          reject(new WebsiteError('unavailable', 'unsupported_content_type'));
          response.destroy();
          return;
        }
        if (
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity') ||
          Number(response.headers['content-length']) > MAX_BODY_BYTES
        ) {
          reject(new WebsiteError('failed', 'body_limit'));
          response.destroy();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            reject(new WebsiteError('failed', 'body_limit'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('aborted', () =>
          reject(new WebsiteError('unavailable', 'response_interrupted')),
        );
        response.once('end', () =>
          resolve({
            status,
            location,
            type,
            body: Buffer.concat(chunks).toString('utf8'),
            headers,
            elapsedMs: Date.now() - started,
          }),
        );
      },
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

export class WebsiteSession {
  readonly attempted = new Set<string>();
  private readonly robots = new Map<string, ReturnType<typeof robotsParser>>();

  constructor(
    private readonly initial: URL,
    private readonly signal: AbortSignal,
    private readonly request = requestPinned,
  ) {}

  private target(value: string, current: URL): URL {
    const next = websiteTarget(new URL(value, current).href);
    if (
      site(next) !== site(this.initial) ||
      (current.protocol === 'https:' && next.protocol !== 'https:')
    ) {
      throw new WebsiteError('blocked', 'off_site_or_insecure_redirect');
    }
    return next;
  }

  private async allowed(url: URL) {
    let policy = this.robots.get(url.origin);
    if (!policy) {
      const robotsUrl = new URL('/robots.txt', url);
      let current = robotsUrl;
      for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const response = await this.request(current, this.signal);
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.location
        ) {
          current = this.target(response.location, current);
          continue;
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 429
        ) {
          throw new WebsiteError('blocked', 'robots_unavailable');
        }
        if (
          response.status !== 404 &&
          response.status !== 410 &&
          (response.status < 200 || response.status >= 300)
        ) {
          throw new WebsiteError('unavailable', 'robots_unavailable');
        }
        policy = robotsParser(robotsUrl.href, response.body);
        this.robots.set(url.origin, policy);
        break;
      }
    }
    if (
      !policy ||
      policy.isAllowed(url.href, CRAWLER) !== true ||
      policy.getCrawlDelay(CRAWLER) > 0
    ) {
      throw new WebsiteError('blocked', 'robots_policy');
    }
  }

  async page(url: URL) {
    let current = this.target(url.href, this.initial);
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      this.attempted.add(current.href);
      await this.allowed(current);
      const response = await this.request(current, this.signal);
      if (
        [301, 302, 303, 307, 308].includes(response.status) &&
        response.location
      ) {
        current = this.target(response.location, current);
        continue;
      }
      if ([401, 403, 429, 451].includes(response.status))
        throw new WebsiteError('blocked', 'site_restricted');
      if (response.status < 200 || response.status >= 300)
        throw new WebsiteError('unavailable', 'site_unavailable');
      if (!/html/i.test(response.type))
        throw new WebsiteError('unavailable', 'unsupported_content_type');
      return {
        url: current,
        html: response.body,
        headers: response.headers ?? {},
        elapsedMs: response.elapsedMs ?? null,
      };
    }
    throw new WebsiteError('failed', 'redirect_limit');
  }

  contactLink(hrefs: string[], current: URL): URL | undefined {
    for (const link of hrefs) {
      try {
        const url = this.target(link, current);
        if (
          url.href !== current.href &&
          /contact|kontakt|контакт|about|impressum|связ/i.test(url.pathname)
        )
          return url;
      } catch {
        // Discard unsupported and external links.
      }
    }
  }
}
