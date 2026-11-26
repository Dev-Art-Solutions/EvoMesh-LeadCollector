import { load } from 'cheerio';
import { Injectable } from '@nestjs/common';
import type { CountryCode } from 'libphonenumber-js';
import {
  bestEmail,
  ContactPage,
  ContactResult,
  extractContacts,
} from './extractors';
import { observedContacts } from '../jobs/leads';
import { setting } from '../jobs/collector.config';
import { scanSite, type SiteScan } from './site-scan';
import { WebsiteError, WebsiteSession, websiteTarget } from './website-fetch';

export function parseContactPage(
  url: string,
  html: string,
  country?: CountryCode,
): ContactPage {
  const $ = load(html);
  if (
    $(
      '#captcha, #challenge-form, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
    ).length
  ) {
    throw new WebsiteError('blocked', 'human_required');
  }
  const jsonLd = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get()
    .slice(0, 30);
  const hrefs = $('a[href]')
    .map((_, el) => $(el).attr('href'))
    .get()
    .slice(0, 500);
  $('script,style,noscript,template,[hidden]').remove();
  $('p,div,li,br,td,h1,h2,h3').append(' ');
  const parsed = extractContacts(
    url,
    { text: $('body').text(), hrefs, jsonLd },
    country,
  );
  const contacts = observedContacts({ ...parsed }, url, Date.now(), country);
  return {
    url,
    emails: contacts
      .filter((contact) => contact.type === 'email')
      .map((contact) => contact.normalized),
    phones: contacts
      .filter((contact) => contact.type === 'phone')
      .map((contact) => contact.normalized),
    socials: contacts
      .filter((contact) => contact.type === 'social')
      .map((contact) => contact.normalized),
  };
}

@Injectable()
export class AppService {
  private readonly timeout = setting('EXTRACT_TIMEOUT', 12000, 1000, 15000);
  private readonly maxConcurrent = setting('EXTRACT_CONCURRENCY', 3, 1, 16);
  private readonly country = process.env.EXTRACT_DEFAULT_COUNTRY as
    | CountryCode
    | undefined;
  private active = 0;

  async extractWebsites(
    { urls }: { urls: string[] },
    cancellation: AbortSignal,
  ) {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(85000)]);
    const data: ContactResult[] = [];
    for (
      let i = 0;
      i < urls.length && !signal.aborted;
      i += this.maxConcurrent
    ) {
      data.push(
        ...(await Promise.all(
          urls
            .slice(i, i + this.maxConcurrent)
            .map((url) => this.extractWebsite({ url }, signal)),
        )),
      );
    }
    return { data, results: data.length };
  }

  async extractWebsite(
    { url }: { url: string },
    cancellation?: AbortSignal,
  ): Promise<ContactResult> {
    if (this.active >= this.maxConcurrent) {
      return {
        url,
        emails: [],
        phones: [],
        socials: [],
        status: 'unavailable',
        error: 'enrichment_busy',
        attempted_urls: [],
        pages: [],
      };
    }
    this.active++;
    const timeout = AbortSignal.timeout(this.timeout);
    const signal = cancellation
      ? AbortSignal.any([timeout, cancellation])
      : timeout;
    let session: WebsiteSession | undefined;
    const pages: ContactPage[] = [];
    let state: ContactResult['status'] = 'not_found';
    let error: string | undefined;
    let scan: SiteScan | undefined;
    try {
      const target = websiteTarget(url.trim());
      session = new WebsiteSession(target, signal);
      const landing = await session.page(target);
      pages.push(
        parseContactPage(landing.url.href, landing.html, this.country),
      );
      try {
        scan = scanSite(landing.html, landing.url, landing.headers, landing.elapsedMs);
      } catch {
        // A page the scanner cannot read leaves the contacts it gave.
      }
      const $ = load(landing.html);
      const links = $('a[href]')
        .map((_, element) => $(element).attr('href'))
        .get()
        .slice(0, 500);
      const contact = session.contactLink(links, landing.url);
      if (contact) {
        const page = await session.page(contact);
        if (page.url.href !== landing.url.href)
          pages.push(parseContactPage(page.url.href, page.html, this.country));
      }
    } catch (failure) {
      state =
        failure instanceof WebsiteError
          ? failure.status
          : signal.aborted
            ? 'unavailable'
            : 'failed';
      error =
        failure instanceof WebsiteError
          ? failure.code
          : signal.aborted
            ? 'timeout_or_cancelled'
            : 'request_failed';
    } finally {
      this.active--;
    }
    const emails = [...new Set(pages.flatMap((page) => page.emails))];
    const phones = [...new Set(pages.flatMap((page) => page.phones))];
    const socials = [...new Set(pages.flatMap((page) => page.socials))];
    return {
      url,
      email: bestEmail(emails),
      emails,
      phones,
      socials,
      pages,
      status:
        emails.length || phones.length || socials.length ? 'found' : state,
      attempted_urls: [...(session?.attempted || [])],
      error,
      ...(scan ? { scan } : {}),
    };
  }
}
