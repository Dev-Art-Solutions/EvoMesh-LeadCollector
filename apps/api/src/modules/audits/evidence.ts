/**
 * Evidence for a marketing audit: everything the report states, collected
 * from public sources with where and when it was observed. Nothing here
 * judges; scoring.ts does. A check that could not run is recorded as such
 * ("not_checked" with the reason), never as a failure.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { load } from 'cheerio';

import { chromePath } from './pdf';

import { scanSite, type SiteScan } from '../app/site-scan';
import { requestPinned, WebsiteError, WebsiteSession, websiteTarget } from '../app/website-fetch';

export interface Observed<T> {
  state: 'observed' | 'not_found' | 'not_checked';
  value?: T;
  source?: string;
  checked_at?: string;
  note?: string;
}

export interface PageSeo {
  url: string;
  title: string | null;
  meta_description: string | null;
  h1: string[];
  h2_count: number;
  words: number;
  images: number;
  images_without_alt: number;
}

export interface PageSpeed {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  best_practices: number | null;
  lcp_ms: number | null;
  cls: number | null;
  tbt_ms: number | null;
  fcp_ms: number | null;
  speed_index_ms: number | null;
}

export interface Competitor {
  name: string;
  rating: number | null;
  review_count: number | null;
  website_url: string | null;
  categories: string[];
  scan: SiteScan | null;
  listing_url: string | null;
}

export interface AuditEvidence {
  generated_at: string;
  language: 'en' | 'bg';
  business: {
    lead_id: string;
    name: string;
    website_url: string | null;
    address: string | null;
    street: string | null;
    postal_code: string | null;
    city: string | null;
    region: string | null;
    country_code: string | null;
    phone: string | null;
    phones: string[];
    emails: string[];
    socials: string[];
    categories: string[];
    main_category: string | null;
    listing_url: string | null;
    observed_at: string | null;
  };
  listing: {
    /** False when the business was never collected from a map listing
     * (an audit ordered by website address): listing checks are unknown. */
    checked: boolean;
    rating: number | null;
    review_count: number | null;
    opening_hours: string | null;
    claimed: boolean | null;
    has_phone: boolean;
    has_website: boolean;
    categories: string[];
    observed_at: string | null;
    source: string | null;
  };
  website: Observed<{
    final_url: string;
    scan: SiteScan;
    pages: PageSeo[];
    http_redirects_to_https: boolean | null;
    robots_txt: boolean;
    sitemap: boolean;
    sitemap_url: string | null;
    phones_on_site: string[];
    page_text_sample: string;
  }>;
  pagespeed: Observed<PageSpeed>;
  competitors: Competitor[];
}

type Row = Record<string, any>;
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const digits = (v: string) => v.replace(/\D/g, '');

export function languageFor(countryCode: string | null | undefined): 'en' | 'bg' {
  return (countryCode ?? '').toUpperCase() === 'BG' ? 'bg' : 'en';
}

/** The lead as stored: profile, contacts and its newest listing evidence. */
export function leadBusiness(db: DatabaseSync, leadId: string) {
  const lead = db.prepare('SELECT id, profile FROM leads WHERE id=?').get(leadId) as Row | undefined;
  if (!lead) return null;
  const profile = JSON.parse(String(lead.profile)) as Row;
  const contacts = db.prepare('SELECT * FROM lead_contacts WHERE lead_id=? ORDER BY observed_at').all(leadId) as Row[];
  const listingRow = db
    .prepare(
      `SELECT evidence FROM lead_sources WHERE lead_id=? AND json_extract(evidence,'$.kind')='listing'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(leadId) as Row | undefined;
  const listing = listingRow ? (JSON.parse(String(listingRow.evidence)) as Row) : null;
  const scanRow = db
    .prepare(
      `SELECT evidence FROM lead_sources WHERE lead_id=? AND json_extract(evidence,'$.kind')='website_technology'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(leadId) as Row | undefined;
  return { profile, contacts, listing, scan: scanRow ? (JSON.parse(String(scanRow.evidence)).fields as SiteScan) : null };
}

function pageSeo(url: string, html: string): { seo: PageSeo; text: string; links: string[] } {
  const $ = load(html);
  $('script, style, noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const images = $('img');
  return {
    seo: {
      url,
      title: $('title').first().text().trim() || null,
      meta_description: $('meta[name="description" i]').attr('content')?.trim() || null,
      h1: $('h1')
        .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120))
        .get()
        .slice(0, 5),
      h2_count: $('h2').length,
      words: text ? text.split(' ').length : 0,
      images: images.length,
      images_without_alt: images.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length,
    },
    text,
    links: $('a[href]')
      .map((_, el) => String($(el).attr('href') ?? ''))
      .get()
      .slice(0, 800),
  };
}

const PRIORITY_PAGES = /contact|about|service|book|appointment|location|menu|team|pricing|faq|контакт|за-нас|услуги/i;

async function crawlWebsite(website: string, signal: AbortSignal): Promise<AuditEvidence['website']> {
  const checked_at = new Date().toISOString();
  let target: URL;
  try {
    target = websiteTarget(website);
  } catch {
    return { state: 'not_checked', note: 'website address is not a public http(s) URL', checked_at };
  }
  const session = new WebsiteSession(target, signal);
  try {
    const landing = await session.page(target);
    const scan = scanSite(landing.html, landing.url, landing.headers, landing.elapsedMs);
    const first = pageSeo(landing.url.href, landing.html);
    const pages: PageSeo[] = [first.seo];
    const texts = [first.text];
    const host = landing.url.hostname.replace(/^www\./, '');
    const candidates = [...new Set(first.links)]
      .map((href) => {
        try {
          return new URL(href, landing.url);
        } catch {
          return null;
        }
      })
      .filter((u): u is URL => !!u && u.hostname.replace(/^www\./, '') === host && /^https?:$/.test(u.protocol))
      .map((u) => {
        u.hash = '';
        return u;
      })
      .filter((u) => u.href !== landing.url.href && !/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(u.pathname));
    const unique = [...new Map(candidates.map((u) => [u.href, u])).values()];
    unique.sort((a, b) => Number(PRIORITY_PAGES.test(b.pathname)) - Number(PRIORITY_PAGES.test(a.pathname)));
    for (const next of unique.slice(0, 5)) {
      if (signal.aborted) break;
      try {
        const page = await session.page(next);
        const parsed = pageSeo(page.url.href, page.html);
        pages.push(parsed.seo);
        texts.push(parsed.text);
      } catch {
        // A page that cannot be read is left out of the sample.
      }
    }
    const origin = new URL('/', landing.url);
    const fetchStatus = async (url: URL) => {
      try {
        return await requestPinned(url, signal);
      } catch {
        return null;
      }
    };
    const robots = await fetchStatus(new URL('/robots.txt', origin));
    const robotsOk = !!robots && robots.status >= 200 && robots.status < 300 && /user-agent|sitemap|disallow|allow/i.test(robots.body);
    const declared = robotsOk ? /^\s*sitemap:\s*(\S+)/im.exec(robots!.body)?.[1] : undefined;
    let sitemapUrl: string | null = null;
    for (const candidate of [declared, '/sitemap.xml', '/sitemap_index.xml', '/wp-sitemap.xml'].filter(Boolean) as string[]) {
      let url: URL;
      try {
        url = new URL(candidate, origin);
      } catch {
        continue;
      }
      if (url.hostname.replace(/^www\./, '') !== host) continue;
      const response = await fetchStatus(url);
      if (response && response.status >= 200 && response.status < 300 && /<(urlset|sitemapindex)/i.test(response.body)) {
        sitemapUrl = url.href;
        break;
      }
    }
    let httpRedirects: boolean | null = null;
    if (landing.url.protocol === 'https:') {
      const plain = new URL(landing.url.href);
      plain.protocol = 'http:';
      plain.pathname = '/';
      const response = await fetchStatus(plain);
      httpRedirects = response ? response.status >= 300 && response.status < 400 && /^https:/i.test(response.location ?? '') : null;
    }
    const allText = texts.join(' ');
    const phonesOnSite = [...new Set((allText.match(/\+?\d[\d\s().-]{7,}\d/g) ?? []).map(digits))]
      .filter((d) => d.length >= 9 && d.length <= 15)
      .slice(0, 20);
    return {
      state: 'observed',
      source: landing.url.href,
      checked_at,
      value: {
        final_url: landing.url.href,
        scan,
        pages,
        http_redirects_to_https: httpRedirects,
        robots_txt: robotsOk,
        sitemap: !!sitemapUrl,
        sitemap_url: sitemapUrl,
        phones_on_site: phonesOnSite,
        page_text_sample: allText.slice(0, 20000),
      },
    };
  } catch (error) {
    const code = error instanceof WebsiteError ? error.code : signal.aborted ? 'timeout' : 'request_failed';
    return {
      state: 'not_checked',
      source: target.href,
      checked_at,
      note:
        code === 'robots_policy' || code === 'robots_unavailable'
          ? "the site's robots.txt does not allow our crawler"
          : code === 'site_restricted'
            ? 'the site refused automated access'
            : `the website could not be read (${code})`,
    };
  }
}

function speedFromLighthouse(lh: Row): PageSpeed {
  const cat = (k: string) => (typeof lh.categories?.[k]?.score === 'number' ? Math.round(lh.categories[k].score * 100) : null);
  const metric = (k: string) => (typeof lh.audits?.[k]?.numericValue === 'number' ? lh.audits[k].numericValue : null);
  return {
    performance: cat('performance'),
    seo: cat('seo'),
    accessibility: cat('accessibility'),
    best_practices: cat('best-practices'),
    lcp_ms: metric('largest-contentful-paint'),
    cls: metric('cumulative-layout-shift'),
    tbt_ms: metric('total-blocking-time'),
    fcp_ms: metric('first-contentful-paint'),
    speed_index_ms: metric('speed-index'),
  };
}

/** Lighthouse run here, mobile emulation, in a throwaway headless profile --
 * the engine PageSpeed Insights runs, used when no PSI key is configured
 * (Google answers keyless PSI calls with 429). */
async function localLighthouse(url: string, signal: AbortSignal): Promise<AuditEvidence['pagespeed']> {
  const checked_at = new Date().toISOString();
  const chrome = chromePath();
  if (!chrome) return { state: 'not_checked', checked_at, note: 'no Chrome to run Lighthouse with' };
  const profile = mkdtempSync(join(tmpdir(), 'lc-lh-'));
  try {
    const cli = require.resolve('lighthouse/cli/index.js');
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          cli, url, '--output=json', '--output-path=stdout', '--quiet', '--max-wait-for-load=45000',
          '--only-categories=performance,seo,accessibility,best-practices',
          `--chrome-flags=--headless=new --disable-gpu --no-first-run --user-data-dir=${profile}`,
        ],
        { env: { ...process.env, CHROME_PATH: chrome }, maxBuffer: 64 * 1024 * 1024, timeout: 150_000, windowsHide: true, signal },
        (error, out) => (out ? resolve(out) : reject(error ?? new Error('no output'))),
      );
    });
    const lh = JSON.parse(stdout) as Row;
    if (lh.runtimeError?.code) return { state: 'not_checked', checked_at, source: 'Lighthouse', note: `Lighthouse could not load the page (${lh.runtimeError.code})` };
    return { state: 'observed', checked_at, source: `Lighthouse ${lh.lighthouseVersion ?? ''} (mobile emulation, run by the auditor)`.trim(), value: speedFromLighthouse(lh) };
  } catch {
    return { state: 'not_checked', checked_at, source: 'Lighthouse', note: 'Lighthouse did not finish in time' };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

/** Google PageSpeed Insights (Lighthouse, mobile) when LEADCOLLECTOR_PSI_KEY
 * is set; otherwise Lighthouse locally. */
async function pageSpeed(url: string, signal: AbortSignal): Promise<AuditEvidence['pagespeed']> {
  if (!process.env.LEADCOLLECTOR_PSI_KEY) return localLighthouse(url, signal);
  const checked_at = new Date().toISOString();
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', 'mobile');
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) api.searchParams.append('category', c);
  if (process.env.LEADCOLLECTOR_PSI_KEY) api.searchParams.set('key', process.env.LEADCOLLECTOR_PSI_KEY);
  try {
    const response = await fetch(api, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) {
      return {
        state: 'not_checked',
        checked_at,
        source: 'Google PageSpeed Insights',
        note: response.status === 429 ? 'PageSpeed Insights quota exhausted' : `PageSpeed Insights answered HTTP ${response.status}`,
      };
    }
    const body = (await response.json()) as Row;
    return {
      state: 'observed',
      checked_at,
      source: 'Google PageSpeed Insights (Lighthouse, mobile)',
      value: speedFromLighthouse(body.lighthouseResult ?? {}),
    };
  } catch {
    return { state: 'not_checked', checked_at, source: 'Google PageSpeed Insights', note: 'PageSpeed Insights did not answer in time' };
  }
}

/** Up to three businesses from our own collection in the same town and
 * main category, most reviewed first. */
export function competitorsOf(db: DatabaseSync, leadId: string, profile: Row, mainCategory: string | null): Competitor[] {
  if (!profile.city || !mainCategory) return [];
  const rows = db
    .prepare(
      `SELECT l.id, l.profile FROM leads l
        WHERE l.id <> ? AND json_extract(l.profile,'$.city') = ?
          AND EXISTS (SELECT 1 FROM lead_sources s WHERE s.lead_id = l.id
                        AND json_extract(s.evidence,'$.kind')='listing'
                        AND json_extract(s.evidence,'$.fields.main_category') = ?)
        ORDER BY CAST(json_extract(l.profile,'$.review_count') AS INTEGER) DESC LIMIT 3`,
    )
    .all(leadId, profile.city, mainCategory) as Row[];
  return rows.map((r) => {
    const p = JSON.parse(String(r.profile)) as Row;
    const scanRow = db
      .prepare(
        `SELECT evidence FROM lead_sources WHERE lead_id=? AND json_extract(evidence,'$.kind')='website_technology'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(r.id) as Row | undefined;
    return {
      name: String(p.name),
      rating: typeof p.rating === 'number' ? p.rating : null,
      review_count: typeof p.review_count === 'number' ? p.review_count : null,
      website_url: p.website_url ?? null,
      categories: p.categories ?? [],
      scan: scanRow ? (JSON.parse(String(scanRow.evidence)).fields as SiteScan) : null,
      listing_url: p.listing_url ?? null,
    };
  });
}

export async function collectEvidence(
  db: DatabaseSync,
  leadId: string,
  signal: AbortSignal,
  options: { pagespeed?: boolean } = {},
): Promise<AuditEvidence> {
  const found = leadBusiness(db, leadId);
  if (!found) throw new Error('lead not found');
  const { profile, contacts, listing } = found;
  const of = (type: string) => [...new Set(contacts.filter((c) => c.type === type).map((c) => String(c.normalized)))];
  const listingPhone = contacts.find((c) => c.type === 'phone' && /google\./.test(String(c.source_url)))?.normalized ?? null;
  const fields = (listing?.fields ?? {}) as Row;
  const mainCategory = (fields.main_category as string) ?? (profile.categories?.[0] as string) ?? null;
  const social = /(^|\.)(facebook|instagram|linktr|tiktok|youtube|x|twitter|linkedin)\.(com|ee)$/i;
  const host = (() => {
    try {
      return new URL(String(profile.website_url)).hostname;
    } catch {
      return '';
    }
  })();
  const website: AuditEvidence['website'] = !profile.website_url
    ? { state: 'not_found' }
    : social.test(host)
      ? {
          state: 'not_found',
          source: String(profile.website_url),
          note: languageFor(profile.country_code) === 'bg'
            ? `Профилът сочи към социална мрежа (${host}), а не към собствен уебсайт`
            : `The listing points to a social profile (${host}), not an own website`,
        }
      : await crawlWebsite(String(profile.website_url), signal);
  const speedTarget = website.state === 'observed' ? website.value!.final_url : null;
  const speed: AuditEvidence['pagespeed'] =
    speedTarget && options.pagespeed !== false
      ? await pageSpeed(speedTarget, signal)
      : { state: 'not_checked', note: speedTarget ? 'skipped' : 'no website to measure' };
  return {
    generated_at: new Date().toISOString(),
    language: languageFor(profile.country_code),
    business: {
      lead_id: leadId,
      name: String(profile.name),
      website_url: profile.website_url ?? null,
      address: profile.address ?? null,
      street: profile.street ?? null,
      postal_code: profile.postal_code ?? null,
      city: profile.city ?? null,
      region: profile.region ?? null,
      country_code: profile.country_code ?? null,
      phone: listingPhone ?? of('phone')[0] ?? null,
      phones: of('phone'),
      emails: of('email'),
      socials: of('social'),
      categories: profile.categories ?? [],
      main_category: mainCategory,
      listing_url: profile.listing_url ?? null,
      observed_at: iso(profile.updated_at),
    },
    listing: {
      checked: Boolean(listing),
      rating: typeof profile.rating === 'number' ? profile.rating : null,
      review_count: typeof profile.review_count === 'number' ? profile.review_count : null,
      opening_hours: profile.opening_hours ?? null,
      claimed: typeof fields.claimed === 'boolean' ? fields.claimed : null,
      has_phone: Boolean(listingPhone),
      has_website: Boolean(profile.website_url),
      categories: profile.categories ?? [],
      observed_at: iso(listing?.observed_at ?? profile.updated_at),
      source: profile.listing_url ?? null,
    },
    website,
    pagespeed: speed,
    competitors: await withScans(competitorsOf(db, leadId, profile, mainCategory), signal),
  };
}

/** Competitors collected before site scans existed have none: read their
 * homepage now (one page each) so the comparison is observed, not "?". */
async function withScans(list: Competitor[], signal: AbortSignal): Promise<Competitor[]> {
  for (const c of list) {
    if (c.scan || !c.website_url || signal.aborted) continue;
    try {
      const target = websiteTarget(c.website_url);
      const landing = await new WebsiteSession(target, AbortSignal.any([signal, AbortSignal.timeout(20_000)])).page(target);
      c.scan = scanSite(landing.html, landing.url, landing.headers, landing.elapsedMs);
    } catch {
      // stays unknown
    }
  }
  return list;
}

export { digits };
