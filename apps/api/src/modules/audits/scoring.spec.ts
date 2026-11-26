import { scanSite } from '../app/site-scan';
import type { AuditEvidence } from './evidence';
import { renderReport } from './report';
import { score } from './scoring';

function evidence(over: Partial<AuditEvidence> = {}): AuditEvidence {
  const html = `<html lang="en"><head><title>Bright Smile Dental Austin</title>
    <meta name="viewport" content="width=device-width"><meta name="description" content="${'x'.repeat(80)}">
    <script src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script></head>
    <body><h1>Dentist</h1><a href="tel:+15125550100">Call</a><a href="/book">Book now</a><a href="/c">Contact us</a></body></html>`;
  const url = new URL('https://brightsmile.example/');
  return {
    generated_at: '2026-11-26T00:00:00.000Z',
    language: 'en',
    business: {
      lead_id: 'l1', name: 'Bright Smile Dental', website_url: url.href, address: '100 Main St, Austin, TX 78701',
      street: '100 Main St', postal_code: '78701', city: 'Austin', region: 'Texas', country_code: 'US', phone: '+15125550100',
      phones: ['+15125550100'], emails: [], socials: [], categories: ['Dentist', 'Cosmetic dentist'], main_category: 'Dentist',
      listing_url: 'https://www.google.com/maps?cid=1', observed_at: '2026-11-25T00:00:00.000Z',
    },
    listing: { rating: 4.8, review_count: 120, opening_hours: 'Mon 9-5', claimed: true, has_phone: true, has_website: true, categories: ['Dentist', 'Cosmetic dentist'], observed_at: '2026-11-25T00:00:00.000Z', source: 'https://www.google.com/maps?cid=1' },
    website: {
      state: 'observed', source: url.href, checked_at: '2026-11-26T00:00:00.000Z',
      value: {
        final_url: url.href, scan: scanSite(html, url), pages: [{ url: url.href, title: 'Bright Smile Dental Austin', meta_description: 'x'.repeat(80), h1: ['Dentist'], h2_count: 0, words: 300, images: 0, images_without_alt: 0 }],
        http_redirects_to_https: true, robots_txt: true, sitemap: false, sitemap_url: null,
        phones_on_site: ['15125550100'], page_text_sample: 'Call 512 555 0100 at 100 Main St, Austin TX 78701',
      },
    },
    pagespeed: { state: 'not_checked', note: 'PageSpeed Insights quota exhausted' },
    competitors: [{ name: 'Other Dental', rating: 4.6, review_count: 300, website_url: null, categories: ['Dentist'], scan: null, listing_url: null }],
    ...over,
  };
}

test('unchecked criteria are left out of the score and listed as not checked', () => {
  const s = score(evidence());
  const perf = s.criteria.find((c) => c.id === 'performance')!;
  expect(perf).toMatchObject({ status: 'unknown', detail: 'PageSpeed Insights quota exhausted' });
  expect(s.criteria.find((c) => c.id === 'https')!.status).toBe('pass');
  expect(s.criteria.find((c) => c.id === 'nap_phone')!.status).toBe('pass');
  expect(s.criteria.find((c) => c.id === 'nap_address')!.status).toBe('pass');
  expect(s.criteria.find((c) => c.id === 'sitemap')!.status).toBe('fail');
  expect(s.criteria.find((c) => c.id === 'review_volume')!.status).toBe('fail'); // 120 vs competitor 300
  expect(s.overall).toBeGreaterThan(0);
  expect(s.overall).toBeLessThanOrEqual(100);
  expect(s.recommendations.map((r) => r.id)).toEqual(expect.arrayContaining(['sitemap', 'meta_pixel', 'review_volume']));
  expect(s.recommendations.find((r) => r.id === 'performance')).toBeUndefined();
});

test('a business without a website is not marked failing on checks that could not run', () => {
  const s = score(evidence({ website: { state: 'not_found' }, business: { ...evidence().business, website_url: null }, listing: { ...evidence().listing, has_website: false } }));
  expect(s.criteria.find((c) => c.id === 'site_exists')!.status).toBe('fail');
  expect(s.criteria.find((c) => c.id === 'mobile')!.status).toBe('unknown');
  expect(s.categories.find((c) => c.id === 'seo')!.score).toBeNull();
  expect(s.recommendations[0].id).toBe('site_exists');
});

test('the report renders in Bulgarian for a Bulgarian business, with every section', () => {
  const e = evidence({ language: 'bg' });
  const html = renderReport(e, score(e), { name: 'Dev Art Solutions', accent: '#2563EB', website: 'https://devart.solutions' });
  for (const heading of ['Представяне на бизнеса', 'Общ маркетингов рейтинг', 'Анализ на уебсайта', 'Технологичен анализ', 'SEO анализ', 'Google Business Profile', 'Бизнес регистрации', 'Онлайн репутация', 'Конкурентен анализ', 'Препоръки и възможности', 'План за действие'])
    expect(html).toContain(heading);
  expect(html).toContain('Не е проверено');
  expect(html).not.toContain('<script');
});
