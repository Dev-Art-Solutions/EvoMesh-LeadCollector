/**
 * The audit as a printable HTML document (A4), turned into a PDF by pdf.ts.
 * Every number on it comes from the evidence with its source and date;
 * unknown is shown as unknown. Branding (name, logo, colour, contacts) comes
 * from LEADCOLLECTOR_BRAND_FILE so the repository stays product-neutral.
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

import type { AuditEvidence } from './evidence';
import type { AuditScore, Criterion, Lang, Recommendation, Status } from './scoring';

export interface Brand {
  name: string;
  website?: string;
  email?: string;
  phone?: string;
  location?: string;
  accent?: string;
  logo_path?: string;
  tagline?: Record<Lang, string>;
}

export function loadBrand(): Brand {
  const file = process.env.LEADCOLLECTOR_BRAND_FILE;
  if (file) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Brand;
    } catch {
      // fall through to the neutral brand
    }
  }
  return { name: 'LeadCollector', accent: '#2563EB' };
}

function logoDataUri(path?: string) {
  if (!path) return null;
  try {
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' }[extname(path).toLowerCase()];
    return mime ? `data:${mime};base64,${readFileSync(path).toString('base64')}` : null;
  } catch {
    return null;
  }
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const COLORS = { good: '#16A34A', mid: '#F59E0B', bad: '#DC2626', none: '#94A3B8' };
const scoreColor = (s: number | null) => (s === null ? COLORS.none : s >= 80 ? COLORS.good : s >= 50 ? COLORS.mid : COLORS.bad);
const statusColor: Record<Status, string> = { pass: COLORS.good, warn: COLORS.mid, fail: COLORS.bad, unknown: COLORS.none };

const TX = {
  en: {
    title: 'Marketing Audit Report', preparedFor: 'Prepared for', preparedBy: 'Prepared by', date: 'Date',
    contents: 'Contents', s1: 'Business overview', s2: 'Overall marketing score', s3: 'Website analysis', s4: 'Technology analysis',
    s5: 'SEO analysis', s6: 'Google Business Profile', s7: 'Business listings', s8: 'Online reputation', s9: 'Competitive analysis',
    s10: 'Recommendations & opportunities', s11: '30 / 60 / 90 day action plan', sources: 'Sources, dates and limitations',
    company: 'Company', website: 'Website', address: 'Address', phone: 'Phone', email: 'Email', category: 'Category', location: 'Location',
    socials: 'Social profiles', rating: 'Google rating', reviews: 'Reviews', about: 'About the business', none: '—',
    criterion: 'Criterion', result: 'Result', finding: 'Finding', score: 'Score', weight: 'Weight', checked: 'Checked',
    pass: 'Pass', warn: 'Needs work', fail: 'Missing / failing', unknown: 'Not checked',
    howScored: 'How the score is calculated',
    howText: 'Each criterion is marked Pass (full points), Needs work (half) or Missing/failing (none). Criteria we could not check are marked Not checked and left out of the score, so a missing check never lowers it. A category score is the share of points earned among its checked criteria; the overall score is the weighted average of the categories that could be checked.',
    exec: 'Summary', strengths: 'What works', issues: 'Biggest gaps', psi: 'Mobile performance (Google PageSpeed Insights / Lighthouse)',
    performance: 'Performance', seoScore: 'SEO', accessibility: 'Accessibility', bestPractices: 'Best practices',
    lcp: 'Largest Contentful Paint', cls: 'Cumulative Layout Shift', tbt: 'Total Blocking Time', fcp: 'First Contentful Paint',
    stack: 'Detected technology', cms: 'CMS / platform', server: 'Server', analytics: 'Analytics', tags: 'Tag manager',
    pixels: 'Advertising pixels', chat: 'Chat / messaging', booking: 'Booking', callTracking: 'Call tracking', detected: 'Detected', notDetected: 'Not detected',
    pagesRead: 'Pages read', page: 'Page', words: 'Words', h1: 'H1', imgAlt: 'Images without alt',
    napTitle: 'Name, address and phone (NAP) consistency', source: 'Source', name: 'Name', exact: 'Matches', partial: 'Partial match', missing: 'Not found',
    directoriesNote: 'Third-party directories (Yelp, Facebook, Apple Maps, Bing Places, industry directories) were not checked for this report.',
    repSummary: 'Reputation at a glance', avgRating: 'Average rating', reviewCount: 'Number of reviews', competitorMedian: 'Competitor median',
    reviewsNote: 'Individual reviews, recurring themes and the owner reply rate were not collected for this report.',
    competitor: 'Business', you: 'This business', compNote: 'Competitors are the most-reviewed businesses in the same town and main category in our collected data.',
    noCompetitors: 'No comparable competitors were found in the collected data.',
    rec: 'Recommendation', impact: 'Impact', effort: 'Effort', when: 'When', high: 'High', medium: 'Medium', low: 'Low',
    quickWins: 'Quick wins', longTerm: 'Longer-term investments', days: 'days', goal: 'Goal', task: 'Task', service: 'How we help',
    noRecs: 'No gaps were found among the criteria checked.',
    legend: 'Legend', legendText: 'Missing = the item does not exist where it should (e.g. no meta description). Not found = we looked in the pages we read and did not find it; it may exist elsewhere. Not checked = this report did not test it.',
    helpTitle: 'How {brand} can help', helpText: 'We fix the gaps in this report end to end: website, technical SEO, Google Business Profile, tracking and advertising, and a review programme. Every task above can be delivered and measured.',
    contact: 'Contact', confidential: 'Confidential — prepared for {name}', noSite: 'This business has no website on its Google profile, so website, SEO, technology and NAP checks could not be run.',
  },
  bg: {
    title: 'Маркетингов одит', preparedFor: 'Изготвен за', preparedBy: 'Изготвен от', date: 'Дата',
    contents: 'Съдържание', s1: 'Представяне на бизнеса', s2: 'Общ маркетингов рейтинг', s3: 'Анализ на уебсайта', s4: 'Технологичен анализ',
    s5: 'SEO анализ', s6: 'Google Business Profile', s7: 'Бизнес регистрации', s8: 'Онлайн репутация', s9: 'Конкурентен анализ',
    s10: 'Препоръки и възможности', s11: 'План за действие: 30 / 60 / 90 дни', sources: 'Източници, дати и ограничения',
    company: 'Компания', website: 'Уебсайт', address: 'Адрес', phone: 'Телефон', email: 'Имейл', category: 'Категория', location: 'Локация',
    socials: 'Социални профили', rating: 'Оценка в Google', reviews: 'Отзиви', about: 'За бизнеса', none: '—',
    criterion: 'Критерий', result: 'Резултат', finding: 'Констатация', score: 'Оценка', weight: 'Тежест', checked: 'Проверени',
    pass: 'Изпълнено', warn: 'Нужно подобрение', fail: 'Липсва / неизпълнено', unknown: 'Не е проверено',
    howScored: 'Как се формира оценката',
    howText: 'Всеки критерий е Изпълнено (пълни точки), Нужно подобрение (половината) или Липсва/неизпълнено (нула). Критериите, които не можахме да проверим, са отбелязани „Не е проверено“ и не влизат в оценката, така че липсваща проверка никога не я намалява. Оценката на категория е делът на спечелените точки сред проверените критерии; общата оценка е претеглената средна стойност на категориите, които могат да бъдат проверени.',
    exec: 'Резюме', strengths: 'Силни страни', issues: 'Най-големи пропуски', psi: 'Мобилна производителност (Google PageSpeed Insights / Lighthouse)',
    performance: 'Производителност', seoScore: 'SEO', accessibility: 'Достъпност', bestPractices: 'Добри практики',
    lcp: 'Largest Contentful Paint', cls: 'Cumulative Layout Shift', tbt: 'Total Blocking Time', fcp: 'First Contentful Paint',
    stack: 'Открити технологии', cms: 'CMS / платформа', server: 'Сървър', analytics: 'Анализ', tags: 'Мениджър на тагове',
    pixels: 'Рекламни пиксели', chat: 'Чат / съобщения', booking: 'Резервации', callTracking: 'Проследяване на обаждания', detected: 'Открито', notDetected: 'Не е открито',
    pagesRead: 'Прочетени страници', page: 'Страница', words: 'Думи', h1: 'H1', imgAlt: 'Изображения без alt',
    napTitle: 'Съответствие на име, адрес и телефон (NAP)', source: 'Източник', name: 'Име', exact: 'Съвпада', partial: 'Частично съвпадение', missing: 'Не е открит',
    directoriesNote: 'Външните директории (Facebook, Apple Maps, Bing Places, отраслови каталози) не са проверени за този отчет.',
    repSummary: 'Репутацията накратко', avgRating: 'Средна оценка', reviewCount: 'Брой отзиви', competitorMedian: 'Медиана при конкурентите',
    reviewsNote: 'Отделните отзиви, повтарящите се теми и процентът отговори от собственика не са събрани за този отчет.',
    competitor: 'Бизнес', you: 'Този бизнес', compNote: 'Конкурентите са бизнесите с най-много отзиви в същия град и основна категория в събраните от нас данни.',
    noCompetitors: 'В събраните данни не са открити сравними конкуренти.',
    rec: 'Препоръка', impact: 'Въздействие', effort: 'Сложност', when: 'Срок', high: 'Високо', medium: 'Средно', low: 'Ниско',
    quickWins: 'Бързи подобрения', longTerm: 'Дългосрочни инвестиции', days: 'дни', goal: 'Цел', task: 'Задача', service: 'Как помагаме',
    noRecs: 'Сред проверените критерии не са открити пропуски.',
    legend: 'Легенда', legendText: 'Липсва = елементът го няма там, където трябва да бъде (напр. няма meta описание). Не е открит = търсихме в прочетените страници и не го намерихме; може да съществува другаде. Не е проверено = този отчет не го е проверявал.',
    helpTitle: 'Как {brand} може да помогне', helpText: 'Отстраняваме пропуските от този отчет изцяло: уебсайт, техническо SEO, Google Business Profile, проследяване и реклама, и програма за отзиви. Всяка задача по-горе може да бъде изпълнена и измерена.',
    contact: 'Контакт', confidential: 'Поверително — изготвено за {name}', noSite: 'В Google профила на бизнеса няма уебсайт, затова проверките на сайта, SEO, технологиите и NAP не могат да бъдат направени.',
  },
};

function gauge(value: number | null, accent: string, label = 'SCORE') {
  const v = value ?? 0;
  const angle = Math.PI * (1 - v / 100);
  const x = 110 + 90 * Math.cos(angle);
  const y = 110 - 90 * Math.sin(angle);
  const color = scoreColor(value);
  return `<svg viewBox="0 0 220 130" width="260" height="154" role="img">
  <path d="M20 110 A90 90 0 0 1 200 110" fill="none" stroke="#E2E8F0" stroke-width="18" stroke-linecap="round"/>
  ${value === null ? '' : `<path d="M20 110 A90 90 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="18" stroke-linecap="round"/>`}
  <text x="110" y="100" text-anchor="middle" font-size="40" font-weight="700" fill="${value === null ? COLORS.none : '#0F172A'}">${value === null ? '—' : v + '%'}</text>
  <text x="110" y="124" text-anchor="middle" font-size="11" fill="${accent}" letter-spacing="2">${label}</text>
</svg>`;
}

function bars(rows: { label: string; value: number | null; note?: string }[]) {
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="bar-row"><div class="bar-label">${esc(r.label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${r.value ?? 0}%;background:${scoreColor(r.value)}"></div></div>
      <div class="bar-value" style="color:${scoreColor(r.value)}">${r.value === null ? '—' : r.value + '%'}</div></div>`,
    )
    .join('')}</div>`;
}

function hbarCompare(rows: { label: string; value: number; highlight: boolean }[], max: number, suffix = '') {
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="stack"><div class="bar-label ${r.highlight ? 'me' : ''}" style="width:auto">${esc(r.label)}</div>
      <div class="bar-row"><div class="bar-track"><div class="bar-fill" style="width:${max ? Math.max(2, (100 * r.value) / max) : 0}%;background:${r.highlight ? 'var(--accent)' : '#94A3B8'}"></div></div>
      <div class="bar-value">${esc(r.value)}${suffix}</div></div></div>`,
    )
    .join('')}</div>`;
}

const pill = (s: Status, t: (typeof TX)['en']) => `<span class="pill" style="background:${statusColor[s]}">${esc(t[s])}</span>`;

function criteriaTable(rows: Criterion[], t: (typeof TX)['en']) {
  return `<table class="grid"><thead><tr><th>${t.criterion}</th><th style="width:120px">${t.result}</th><th>${t.finding}</th></tr></thead><tbody>${rows
    .map((c) => `<tr><td>${esc(c.label)}</td><td>${pill(c.status, t)}</td><td class="muted">${esc(c.detail)}</td></tr>`)
    .join('')}</tbody></table>`;
}

const fmtMs = (v: number | null) => (v === null ? '—' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');

function goalFor(r: Recommendation, e: AuditEvidence, lang: Lang): string {
  const p = e.pagespeed.state === 'observed' ? e.pagespeed.value : undefined;
  const compMedian = (() => {
    const xs = e.competitors.map((c) => c.review_count ?? 0).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  })();
  const g: Record<string, [string, string]> = {
    site_exists: ['Website live with service pages, contact form and tracking', 'Работещ сайт със страници за услугите, форма за контакт и проследяване'],
    https: ['100% of pages on HTTPS, no browser warnings', '100% от страниците на HTTPS, без предупреждения'],
    mobile: ['Mobile-friendly on every page', 'Всички страници адаптирани за мобилни'],
    performance: [`Mobile PageSpeed ≥ 70 (now ${p?.performance ?? '—'})`, `Мобилен PageSpeed ≥ 70 (сега ${p?.performance ?? '—'})`],
    lcp: ['LCP under 2.5 s on mobile', 'LCP под 2,5 s на мобилни'],
    cta: ['Measurable rise in calls and form enquiries', 'Измеримо увеличение на обажданията и запитванията'],
    analytics: ['GA4 recording visits and key conversions', 'GA4 отчита посещения и ключови конверсии'],
    meta_pixel: ['Pixel firing on all pages with lead events', 'Pixel активен на всички страници със събития за запитване'],
    ads_conversion: ['Calls and forms recorded as Google Ads conversions', 'Обажданията и формите се отчитат като конверсии в Google Ads'],
    gbp_claimed: ['Profile verified and 100% complete', 'Потвърден и 100% попълнен профил'],
    review_volume: [compMedian !== null ? `Reach ${compMedian}+ reviews (competitor median)` : '+10 new reviews per month', compMedian !== null ? `Достигане на ${compMedian}+ отзива (медианата на конкурентите)` : '+10 нови отзива на месец'],
    rating: ['Average rating 4.5★ or higher', 'Средна оценка 4,5★ или повече'],
    local_schema: ['LocalBusiness markup valid in Google’s Rich Results Test', 'Валидно LocalBusiness маркиране в Rich Results Test'],
  };
  const pair = g[r.id];
  return pair ? (lang === 'bg' ? pair[1] : pair[0]) : lang === 'bg' ? 'Изпълнено и проверено' : 'Done and verified';
}

export function renderReport(e: AuditEvidence, s: AuditScore, brand: Brand): string {
  const lang = e.language;
  const t = TX[lang];
  const accent = brand.accent ?? '#2563EB';
  const logo = logoDataUri(brand.logo_path);
  const b = e.business;
  const site = e.website.state === 'observed' ? e.website.value! : null;
  const psi = e.pagespeed.state === 'observed' ? e.pagespeed.value! : null;
  const date = new Date(e.generated_at).toLocaleDateString(lang === 'bg' ? 'bg-BG' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const byCat = (id: string) => s.criteria.filter((c) => c.category === id);
  const strengths = s.criteria.filter((c) => c.status === 'pass').slice(0, 5);
  const gaps = s.recommendations.slice(0, 5);
  const description = site?.pages[0]?.meta_description;
  const compMedianReviews = (() => {
    const xs = e.competitors.map((c) => c.review_count ?? 0).sort((x, y) => x - y);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  })();
  const yesNo = (v: boolean) => `<span style="color:${v ? COLORS.good : COLORS.bad};font-weight:600">${v ? t.detected : t.notDetected}</span>`;
  const list = (xs: string[]) => (xs.length ? xs.map(esc).join(', ') : `<span class="muted">${t.notDetected}</span>`);
  const section = (n: number, title: string, body: string) => `<section class="sec"><h2><span class="num">${n}</span>${esc(title)}</h2>${body}</section>`;
  const noSite = !site ? `<p class="note">${esc(e.website.state === 'not_found' ? t.noSite : (e.website.note ?? t.noSite))}</p>` : '';

  const s1 = `<table class="kv">
    <tr><th>${t.company}</th><td><b>${esc(b.name)}</b></td></tr>
    <tr><th>${t.website}</th><td>${b.website_url ? `<a href="${esc(b.website_url)}">${esc(b.website_url)}</a>` : t.none}</td></tr>
    <tr><th>${t.address}</th><td>${esc(b.address ?? t.none)}</td></tr>
    <tr><th>${t.phone}</th><td>${esc(b.phone ?? t.none)}</td></tr>
    <tr><th>${t.email}</th><td>${esc(b.emails[0] ?? t.none)}</td></tr>
    <tr><th>${t.category}</th><td>${esc(b.categories.join(', ') || t.none)}</td></tr>
    <tr><th>${t.location}</th><td>${esc([b.city, b.region, b.country_code].filter(Boolean).join(', ') || t.none)}</td></tr>
    <tr><th>${t.rating}</th><td>${e.listing.rating !== null ? `${e.listing.rating.toFixed(1)} ★ · ${e.listing.review_count ?? 0} ${t.reviews.toLowerCase()}` : t.none}</td></tr>
    <tr><th>${t.socials}</th><td>${b.socials.length ? b.socials.slice(0, 6).map((u) => `<a href="${esc(u)}">${esc(u.replace(/^https?:\/\/(www\.)?/, ''))}</a>`).join('<br>') : t.none}</td></tr>
  </table>
  ${description ? `<h3>${t.about}</h3><p>${esc(description)} <span class="muted">(${esc(site!.pages[0].url)})</span></p>` : ''}`;

  const s2 = `<div class="score-wrap"><div>${gauge(s.overall, accent, lang === 'bg' ? 'ОЦЕНКА' : 'SCORE')}</div><div style="flex:1">${bars(s.categories.map((c) => ({ label: c.label, value: c.score })))}</div></div>
  <table class="grid"><thead><tr><th>${t.category}</th><th>${t.score}</th><th>${t.weight}</th><th>${t.checked}</th></tr></thead><tbody>${s.categories
    .map((c) => `<tr><td>${esc(c.label)}</td><td style="color:${scoreColor(c.score)};font-weight:700">${c.score === null ? t.unknown : c.score + '%'}</td><td>${c.weight}%</td><td>${c.known}/${c.total}</td></tr>`)
    .join('')}</tbody></table>
  <div class="two"><div><h3>${t.strengths}</h3><ul>${strengths.map((c) => `<li>${esc(c.label)} <span class="muted">— ${esc(c.detail)}</span></li>`).join('') || `<li class="muted">${t.none}</li>`}</ul></div>
  <div><h3>${t.issues}</h3><ul>${gaps.map((r) => `<li>${esc(r.title)}</li>`).join('') || `<li class="muted">${t.noRecs}</li>`}</ul></div></div>
  <h3>${t.howScored}</h3><p class="muted small">${esc(t.howText)}</p>`;

  const psiCards = psi
    ? `<h3>${t.psi}</h3><div class="cards">${(
        [
          [t.performance, psi.performance],
          [t.seoScore, psi.seo],
          [t.accessibility, psi.accessibility],
          [t.bestPractices, psi.best_practices],
        ] as [string, number | null][]
      )
        .map(([label, v]) => `<div class="card"><div class="ring" style="border-color:${scoreColor(v)};color:${scoreColor(v)}">${v ?? '—'}</div><div>${esc(label)}</div></div>`)
        .join('')}</div>
      <table class="grid small"><tbody>
      <tr><td>${t.lcp}</td><td>${fmtMs(psi.lcp_ms)}</td><td>${t.fcp}</td><td>${fmtMs(psi.fcp_ms)}</td></tr>
      <tr><td>${t.tbt}</td><td>${fmtMs(psi.tbt_ms)}</td><td>${t.cls}</td><td>${psi.cls === null ? '—' : psi.cls.toFixed(2)}</td></tr></tbody></table>`
    : `<p class="note">${esc(t.psi)}: ${esc(e.pagespeed.note ?? t.unknown)}</p>`;
  const s3 = `${noSite}${criteriaTable(byCat('website'), t)}${psiCards}`;

  const s4 = site
    ? `<table class="kv">
      <tr><th>${t.cms}</th><td>${esc(site.scan.cms ?? t.notDetected)}${site.scan.builders.length ? ' · ' + esc(site.scan.builders.join(', ')) : ''}</td></tr>
      <tr><th>${t.server}</th><td>${esc(site.scan.server ?? t.notDetected)}</td></tr>
      <tr><th>Google Analytics 4</th><td>${yesNo(site.scan.analytics.ga4)} ${esc(site.scan.ids.ga4.join(', '))}</td></tr>
      <tr><th>${t.tags}</th><td>${yesNo(site.scan.analytics.gtm)} ${esc(site.scan.ids.gtm.join(', '))}</td></tr>
      <tr><th>Meta Pixel</th><td>${yesNo(site.scan.analytics.meta_pixel)}</td></tr>
      <tr><th>Google Ads</th><td>${yesNo(site.scan.analytics.google_ads)} ${esc(site.scan.ids.google_ads.join(', '))}</td></tr>
      <tr><th>${t.pixels}</th><td>${list([site.scan.analytics.tiktok_pixel ? 'TikTok' : '', site.scan.analytics.linkedin_insight ? 'LinkedIn Insight' : '', site.scan.analytics.hotjar ? 'Hotjar' : '', site.scan.analytics.clarity ? 'Microsoft Clarity' : ''].filter(Boolean))}</td></tr>
      <tr><th>${t.chat}</th><td>${list([...site.scan.chat, ...(site.scan.conversion.whatsapp ? ['WhatsApp'] : [])])}</td></tr>
      <tr><th>${t.booking}</th><td>${list(site.scan.booking)}</td></tr>
      <tr><th>${t.callTracking}</th><td>${list(site.scan.call_tracking)}</td></tr>
    </table>${criteriaTable(byCat('technology'), t)}`
    : `${noSite}${criteriaTable(byCat('technology'), t)}`;

  const s5 = `${noSite}${criteriaTable(byCat('seo'), t)}${
    site
      ? `<h3>${t.pagesRead}</h3><table class="grid small"><thead><tr><th>${t.page}</th><th>Title</th><th>${t.h1}</th><th>${t.words}</th><th>${t.imgAlt}</th></tr></thead><tbody>${site.pages
          .map((p) => `<tr><td>${esc(p.url.replace(/^https?:\/\//, '').slice(0, 60))}</td><td>${esc((p.title ?? '—').slice(0, 60))}</td><td>${p.h1.length}</td><td>${p.words}</td><td>${p.images_without_alt}/${p.images}</td></tr>`)
          .join('')}</tbody></table>`
      : ''
  }`;

  const s6 = criteriaTable(byCat('gbp'), t) + (e.listing.source ? `<p class="muted small">${t.source}: <a href="${esc(e.listing.source)}">${esc(e.listing.source)}</a> · ${esc(e.listing.observed_at ?? '')}</p>` : '');

  const napPhone = s.criteria.find((c) => c.id === 'nap_phone')!;
  const napAddr = s.criteria.find((c) => c.id === 'nap_address')!;
  const napWord = (st: Status) => (st === 'pass' ? t.exact : st === 'warn' ? t.partial : st === 'fail' ? t.missing : t.unknown);
  const s7 = `<h3>${t.napTitle}</h3><table class="grid"><thead><tr><th></th><th>Google</th><th>${t.website}</th><th>${t.result}</th></tr></thead><tbody>
    <tr><td>${t.name}</td><td>${esc(b.name)}</td><td>${site ? esc((site.pages[0].title ?? '').slice(0, 60)) : t.none}</td><td class="muted">${t.unknown}</td></tr>
    <tr><td>${t.address}</td><td>${esc(b.address ?? t.none)}</td><td>${site ? '…' : t.none}</td><td>${pill(napAddr.status, t)} ${esc(napWord(napAddr.status))}</td></tr>
    <tr><td>${t.phone}</td><td>${esc(b.phone ?? t.none)}</td><td>${site ? esc(site.phones_on_site.slice(0, 3).join(', ') || t.none) : t.none}</td><td>${pill(napPhone.status, t)} ${esc(napWord(napPhone.status))}</td></tr>
  </tbody></table><p class="note">${esc(t.directoriesNote)}</p>`;

  const compRows = [
    { label: `${b.name} (${t.you})`, rating: e.listing.rating ?? 0, reviews: e.listing.review_count ?? 0, me: true },
    ...e.competitors.map((c) => ({ label: c.name, rating: c.rating ?? 0, reviews: c.review_count ?? 0, me: false })),
  ];
  const maxReviews = Math.max(...compRows.map((r) => r.reviews), 1);
  const s8 = `${criteriaTable(byCat('reputation'), t)}
    <div class="two"><div><h3>${t.avgRating}</h3>${hbarCompare(compRows.map((r) => ({ label: r.label, value: r.rating, highlight: r.me })), 5, ' ★')}</div>
    <div><h3>${t.reviewCount}</h3>${hbarCompare(compRows.map((r) => ({ label: r.label, value: r.reviews, highlight: r.me })), maxReviews)}</div></div>
    ${compMedianReviews !== null ? `<p class="muted small">${t.competitorMedian}: ${compMedianReviews}</p>` : ''}
    <p class="note">${esc(t.reviewsNote)}</p>`;

  const s9 = e.competitors.length
    ? `<table class="grid"><thead><tr><th>${t.competitor}</th><th>${t.rating}</th><th>${t.reviews}</th><th>${t.website}</th><th>HTTPS</th><th>Mobile</th><th>GA4</th><th>Meta Pixel</th><th>Google Ads</th></tr></thead><tbody>${[
        { name: `${b.name} (${t.you})`, rating: e.listing.rating, review_count: e.listing.review_count, website_url: b.website_url, scan: site?.scan ?? null, me: true },
        ...e.competitors.map((c) => ({ ...c, me: false })),
      ]
        .map((c) => {
          const mark = (v: boolean | undefined) => (c.scan ? (v ? `<span style="color:${COLORS.good}">●</span>` : `<span style="color:${COLORS.bad}">○</span>`) : '<span class="muted">?</span>');
          return `<tr class="${c.me ? 'me-row' : ''}"><td>${esc(c.name)}</td><td>${c.rating ?? '—'}</td><td>${c.review_count ?? '—'}</td><td>${c.website_url ? '✔' : '✖'}</td><td>${mark(c.scan?.https)}</td><td>${mark(c.scan?.mobile_viewport)}</td><td>${mark(c.scan?.analytics.ga4)}</td><td>${mark(c.scan?.analytics.meta_pixel)}</td><td>${mark(c.scan?.analytics.google_ads)}</td></tr>`;
        })
        .join('')}</tbody></table><p class="muted small">${esc(t.compNote)} ● ${t.detected} · ○ ${t.notDetected} · ? ${t.unknown}</p>`
    : `<p class="note">${esc(t.noCompetitors)}</p>`;

  const lvl = (v: string) => (t as Record<string, string>)[v] ?? v;
  const recTable = (rows: Recommendation[]) =>
    `<table class="grid"><thead><tr><th>${t.rec}</th><th>${t.impact}</th><th>${t.effort}</th><th>${t.when}</th><th>${t.service}</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td><b>${esc(r.title)}</b><div class="muted small">${esc(r.why)}</div></td><td><span class="lvl ${r.impact}">${esc(lvl(r.impact))}</span></td><td>${esc(lvl(r.effort))}</td><td>${r.horizon} ${t.days}</td><td class="small">${esc(r.service)}</td></tr>`)
      .join('')}</tbody></table>`;
  const quick = s.recommendations.filter((r) => r.quick_win);
  const longer = s.recommendations.filter((r) => !r.quick_win);
  const s10 = s.recommendations.length
    ? `${quick.length ? `<h3>${t.quickWins}</h3>${recTable(quick)}` : ''}${longer.length ? `<h3>${t.longTerm}</h3>${recTable(longer)}` : ''}`
    : `<p class="note">${esc(t.noRecs)}</p>`;

  // About five tasks a month, most important first; work that needs more
  // than a quick change never lands before its own horizon.
  const scheduled = s.recommendations.map((r, i) => ({ ...r, horizon: Math.max(r.horizon, i < 5 ? 30 : i < 10 ? 60 : 90) as 30 | 60 | 90 }));
  const plan = ([30, 60, 90] as const)
    .map((h) => {
      const rows = scheduled.filter((r) => r.horizon === h);
      return `<div class="plan-col"><div class="plan-head">${h} ${t.days}</div>${
        rows.length
          ? rows.map((r) => `<div class="plan-item"><b>${esc(r.title)}</b><div class="small">${t.goal}: ${esc(goalFor(r, e, lang))}</div></div>`).join('')
          : `<div class="muted small">${t.none}</div>`
      }</div>`;
    })
    .join('');
  const s11 = `<div class="plan">${plan}</div>`;

  const sources = `<table class="grid small"><tbody>
    <tr><td>Google Maps</td><td>${esc(e.listing.source ?? t.none)}</td><td>${esc(e.listing.observed_at ?? '')}</td></tr>
    <tr><td>${t.website}</td><td>${esc(e.website.source ?? t.none)}</td><td>${esc(e.website.checked_at ?? '')} ${e.website.state !== 'observed' ? '· ' + esc(e.website.note ?? e.website.state) : ''}</td></tr>
    <tr><td>PageSpeed Insights</td><td>${esc(e.pagespeed.source ?? 'Google PageSpeed Insights')}</td><td>${esc(e.pagespeed.checked_at ?? '')} ${e.pagespeed.state !== 'observed' ? '· ' + esc(e.pagespeed.note ?? '') : ''}</td></tr>
  </tbody></table><h3>${t.legend}</h3><p class="muted small">${esc(t.legendText)}</p>`;

  const help = `<section class="sec cta-box"><h2>${esc(t.helpTitle.replace('{brand}', brand.name))}</h2><p>${esc(t.helpText)}</p>
    <p><b>${t.contact}:</b> ${[brand.website, brand.email, brand.phone, brand.location].filter(Boolean).map(esc).join(' · ')}</p></section>`;

  const toc = [t.s1, t.s2, t.s3, t.s4, t.s5, t.s6, t.s7, t.s8, t.s9, t.s10, t.s11].map((x, i) => `<li><span>${i + 1}</span>${esc(x)}</li>`).join('');

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(t.title)} — ${esc(b.name)}</title>
<style>
:root{--accent:${accent};--text:#0F172A;--muted:#64748B;--line:#E2E8F0;--soft:#F6F8FB}
@page{size:A4;margin:16mm 14mm 18mm 14mm}
*{box-sizing:border-box}
body{font-family:"Segoe UI",Inter,Roboto,Arial,sans-serif;color:var(--text);font-size:10.5pt;line-height:1.45;margin:0}
a{color:var(--accent);text-decoration:none;word-break:break-all}
.cover{height:262mm;display:flex;flex-direction:column;justify-content:space-between;page-break-after:always;border-left:10px solid var(--accent);padding:10mm 10mm 6mm 14mm;background:linear-gradient(160deg,#fff 55%,var(--soft))}
.cover .logo{height:52px}
.cover h1{font-size:34pt;margin:0 0 4mm;letter-spacing:-.5px}
.cover .biz{font-size:20pt;color:var(--accent);font-weight:600}
.cover .meta{color:var(--muted);font-size:11pt;margin-top:6mm}
.cover .score-mini{display:flex;align-items:center;gap:8mm}
.toc{page-break-after:always}
.toc ol{list-style:none;padding:0;columns:1}
.toc li{padding:2.2mm 0;border-bottom:1px solid var(--line);font-size:12pt}
.toc li span{display:inline-block;width:10mm;color:var(--accent);font-weight:700}
h2{font-size:16pt;margin:0 0 4mm;color:var(--text);border-bottom:2px solid var(--accent);padding-bottom:2mm}
h2 .num{display:inline-block;background:var(--accent);color:#fff;border-radius:6px;width:9mm;text-align:center;margin-right:3mm;font-size:12pt;padding:1px 0}
h3{font-size:11.5pt;margin:5mm 0 2mm;color:var(--accent)}
.sec{page-break-inside:auto;margin-bottom:8mm}
.sec+.sec{page-break-before:always}
table{border-collapse:collapse;width:100%;margin:2mm 0 3mm}
.grid th{background:var(--soft);text-align:left;font-size:9pt;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;padding:2mm;border-bottom:1px solid var(--line)}
.grid td{padding:2mm;border-bottom:1px solid var(--line);vertical-align:top}
.kv th{width:42mm;text-align:left;color:var(--muted);font-weight:600;padding:1.6mm 2mm;border-bottom:1px solid var(--line);vertical-align:top}
.kv td{padding:1.6mm 2mm;border-bottom:1px solid var(--line)}
.pill{display:inline-block;color:#fff;border-radius:10px;padding:.3mm 2.4mm;font-size:8.5pt;font-weight:600;white-space:nowrap}
.muted{color:var(--muted)} .small{font-size:8.8pt}
.note{background:var(--soft);border-left:3px solid var(--muted);padding:2.5mm 3mm;color:var(--muted);font-size:9.5pt}
.score-wrap{display:flex;gap:8mm;align-items:center;margin-bottom:4mm}
.bars{display:flex;flex-direction:column;gap:2.2mm}
.bar-row{display:flex;align-items:center;gap:3mm}
.bar-label{width:58mm;font-size:9.5pt}
.bar-label.me{font-weight:700;color:var(--accent)}
.bar-track{flex:1;height:5mm;background:var(--soft);border-radius:3mm;overflow:hidden}
.bar-fill{height:100%;border-radius:3mm}
.stack{display:flex;flex-direction:column;gap:.8mm}
.bar-value{width:16mm;text-align:right;font-weight:700;font-size:9.5pt}
.two{display:flex;gap:8mm}.two>div{flex:1}
.cards{display:flex;gap:4mm;margin:2mm 0 3mm}
.card{flex:1;border:1px solid var(--line);border-radius:3mm;padding:3mm;text-align:center;font-size:9pt;color:var(--muted)}
.ring{width:18mm;height:18mm;border-radius:50%;border:2.2mm solid;margin:0 auto 2mm;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13pt}
.lvl{font-weight:700}.lvl.high{color:${COLORS.bad}}.lvl.medium{color:${COLORS.mid}}.lvl.low{color:${COLORS.good}}
.me-row td{background:#EFF6FF;font-weight:600}
.plan{display:flex;gap:4mm}.plan-col{flex:1;border:1px solid var(--line);border-radius:3mm;overflow:hidden}
.plan-head{background:var(--accent);color:#fff;font-weight:700;padding:2.5mm 3mm}
.plan-item{padding:2.5mm 3mm;border-bottom:1px solid var(--line)}
.cta-box{background:var(--soft);border-radius:4mm;padding:6mm;border:1px solid var(--line)}
ul{margin:1mm 0;padding-left:5mm}
</style></head><body>
<div class="cover">
  <div>${logo ? `<img class="logo" src="${logo}" alt="${esc(brand.name)}">` : `<b style="font-size:18pt">${esc(brand.name)}</b>`}</div>
  <div>
    <div class="muted" style="letter-spacing:3px;text-transform:uppercase">${esc(brand.tagline?.[lang] ?? '')}</div>
    <h1>${esc(t.title)}</h1>
    <div class="biz">${esc(b.name)}</div>
    <div class="meta">${esc([b.city, b.region].filter(Boolean).join(', '))}${b.website_url ? ' · ' + esc(b.website_url) : ''}</div>
    <div class="score-mini" style="margin-top:10mm">${gauge(s.overall, accent, lang === 'bg' ? 'ОЦЕНКА' : 'SCORE')}</div>
  </div>
  <div class="meta">${t.preparedFor}: <b>${esc(b.name)}</b><br>${t.preparedBy}: <b>${esc(brand.name)}</b>${brand.website ? ' · ' + esc(brand.website) : ''}<br>${t.date}: ${esc(date)}<br><span class="small">${esc(t.confidential.replace('{name}', b.name))}</span></div>
</div>
<div class="toc"><h2>${t.contents}</h2><ol>${toc}</ol></div>
${section(1, t.s1, s1)}
${section(2, t.s2, s2)}
${section(3, t.s3, s3)}
${section(4, t.s4, s4)}
${section(5, t.s5, s5)}
${section(6, t.s6, s6)}
${section(7, t.s7, s7)}
${section(8, t.s8, s8)}
${section(9, t.s9, s9)}
${section(10, t.s10, s10)}
${section(11, t.s11, s11)}
<section class="sec"><h2>${t.sources}</h2>${sources}</section>
${help}
</body></html>`;
}
