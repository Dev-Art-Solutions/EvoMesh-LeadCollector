/**
 * Transparent rules from evidence to scores and recommendations.
 *
 * Each criterion is pass / warn (half credit) / fail, or unknown when the
 * evidence for it was not checked; unknown criteria are left out of the
 * score and listed as such, so a missing check never lowers a business's
 * score and never reads as a finding. A category score is the share of
 * points earned among its known criteria; the overall score is the weighted
 * average of the categories that have any known criterion.
 */
import type { AuditEvidence } from './evidence';
import { digits } from './evidence';

export type Lang = 'en' | 'bg';
export type Status = 'pass' | 'warn' | 'fail' | 'unknown';
export type CategoryId = 'website' | 'seo' | 'technology' | 'gbp' | 'reputation' | 'listings';

export interface Criterion {
  id: string;
  category: CategoryId;
  label: string;
  status: Status;
  detail: string;
  weight: number;
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  horizon: 30 | 60 | 90;
  quick_win: boolean;
  service: string;
}

export interface AuditScore {
  overall: number | null;
  categories: { id: CategoryId; label: string; score: number | null; weight: number; known: number; total: number }[];
  criteria: Criterion[];
  recommendations: Recommendation[];
}

export const CATEGORY_WEIGHTS: Record<CategoryId, number> = {
  website: 25,
  seo: 20,
  technology: 15,
  gbp: 20,
  reputation: 15,
  listings: 5,
};

const T = {
  en: {
    website: 'Website', seo: 'SEO', technology: 'Marketing technology', gbp: 'Google Business Profile',
    reputation: 'Online reputation', listings: 'Business listings (NAP)',
    notChecked: 'Not checked', noSite: 'No website found on the listing', yes: 'Yes', no: 'No',
  },
  bg: {
    website: 'Уебсайт', seo: 'SEO', technology: 'Маркетингови технологии', gbp: 'Google Business Profile',
    reputation: 'Онлайн репутация', listings: 'Бизнес регистрации (NAP)',
    notChecked: 'Не е проверено', noSite: 'В профила няма уебсайт', yes: 'Да', no: 'Не',
  },
};

export function categoryLabel(id: CategoryId, lang: Lang) {
  return T[lang][id];
}

type Def = {
  id: string;
  category: CategoryId;
  weight: number;
  label: Record<Lang, string>;
  test: (e: AuditEvidence, lang: Lang) => { status: Status; detail: string };
};

const L = (en: string, bg: string) => ({ en, bg });
const pick = (lang: Lang, en: string, bg: string) => (lang === 'bg' ? bg : en);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const site = (e: AuditEvidence) => (e.website.state === 'observed' ? e.website.value! : null);
const unknown = (lang: Lang, why?: string) => ({ status: 'unknown' as const, detail: why ?? T[lang].notChecked });
const noSiteUnknown = (e: AuditEvidence, lang: Lang) =>
  unknown(lang, e.website.state === 'not_found' ? T[lang].noSite : (e.website.note ?? T[lang].notChecked));

const DEFS: Def[] = [
  // -- website ----------------------------------------------------------------
  {
    id: 'site_exists', category: 'website', weight: 3, label: L('Website exists and loads', 'Сайтът съществува и се зарежда'),
    test: (e, lang) =>
      e.website.state === 'observed'
        ? { status: 'pass', detail: site(e)!.final_url }
        : e.website.state === 'not_found'
          ? { status: 'fail', detail: e.website.note ?? T[lang].noSite }
          : unknown(lang, e.website.note),
  },
  {
    id: 'https', category: 'website', weight: 2, label: L('Secure connection (HTTPS)', 'Защитена връзка (HTTPS)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.https ? { status: 'pass', detail: 'HTTPS' } : { status: 'fail', detail: pick(lang, 'Site is served over plain HTTP', 'Сайтът се зарежда без HTTPS') };
    },
  },
  {
    id: 'https_redirect', category: 'website', weight: 1, label: L('HTTP redirects to HTTPS', 'HTTP пренасочва към HTTPS'),
    test: (e, lang) => {
      const s = site(e);
      if (!s || s.http_redirects_to_https === null) return noSiteUnknown(e, lang);
      return s.http_redirects_to_https ? { status: 'pass', detail: T[lang].yes } : { status: 'warn', detail: pick(lang, 'http:// version does not redirect', 'http:// версията не пренасочва') };
    },
  },
  {
    id: 'mobile', category: 'website', weight: 2, label: L('Mobile-friendly viewport', 'Адаптивен за мобилни устройства'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.mobile_viewport ? { status: 'pass', detail: 'meta viewport' } : { status: 'fail', detail: pick(lang, 'No responsive viewport tag', 'Липсва адаптивен viewport') };
    },
  },
  {
    id: 'performance', category: 'website', weight: 3, label: L('Mobile speed (PageSpeed score)', 'Скорост на мобилни (PageSpeed)'),
    test: (e, lang) => {
      const p = e.pagespeed.state === 'observed' ? e.pagespeed.value! : null;
      if (!p || p.performance === null) return unknown(lang, e.pagespeed.note);
      return { status: p.performance >= 90 ? 'pass' : p.performance >= 50 ? 'warn' : 'fail', detail: `${p.performance}/100` };
    },
  },
  {
    id: 'lcp', category: 'website', weight: 2, label: L('Largest Contentful Paint', 'Largest Contentful Paint (зареждане)'),
    test: (e, lang) => {
      const p = e.pagespeed.state === 'observed' ? e.pagespeed.value! : null;
      if (!p || p.lcp_ms === null) return unknown(lang, e.pagespeed.note);
      const s = (p.lcp_ms / 1000).toFixed(1) + ' s';
      return { status: p.lcp_ms <= 2500 ? 'pass' : p.lcp_ms <= 4000 ? 'warn' : 'fail', detail: s };
    },
  },
  {
    id: 'cls', category: 'website', weight: 1, label: L('Layout stability (CLS)', 'Стабилност на страницата (CLS)'),
    test: (e, lang) => {
      const p = e.pagespeed.state === 'observed' ? e.pagespeed.value! : null;
      if (!p || p.cls === null) return unknown(lang, e.pagespeed.note);
      return { status: p.cls <= 0.1 ? 'pass' : p.cls <= 0.25 ? 'warn' : 'fail', detail: p.cls.toFixed(2) };
    },
  },
  {
    id: 'cta', category: 'website', weight: 2, label: L('Clear calls to action', 'Ясни призиви за действие'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const n = s.scan.conversion.cta_buttons;
      return { status: n >= 2 ? 'pass' : n === 1 ? 'warn' : 'fail', detail: pick(lang, `${n} call-to-action button(s) on the homepage`, `${n} бутона с призив за действие на началната страница`) };
    },
  },
  {
    id: 'click_to_call', category: 'website', weight: 1, label: L('Click-to-call phone link', 'Телефон с бързо обаждане (tel:)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.conversion.tel_links > 0 ? { status: 'pass', detail: T[lang].yes } : { status: 'fail', detail: pick(lang, 'No tel: link on the homepage', 'Няма tel: връзка на началната страница') };
    },
  },
  {
    id: 'contact_form', category: 'website', weight: 1, label: L('Contact or booking form', 'Форма за контакт или резервация'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const ok = s.scan.conversion.forms > 0 || s.scan.booking.length > 0;
      return ok ? { status: 'pass', detail: s.scan.booking.join(', ') || pick(lang, 'Form on the homepage', 'Форма на началната страница') } : { status: 'warn', detail: pick(lang, 'No form or booking widget on the homepage', 'Няма форма или система за резервации на началната страница') };
    },
  },
  // -- seo --------------------------------------------------------------------
  {
    id: 'title', category: 'seo', weight: 2, label: L('Page title (10–65 characters)', 'Заглавие на страницата (10–65 знака)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const n = s.scan.seo.title_length;
      return { status: n >= 10 && n <= 65 ? 'pass' : n ? 'warn' : 'fail', detail: n ? `${n} ${pick(lang, 'characters', 'знака')}` : pick(lang, 'Missing', 'Липсва') };
    },
  },
  {
    id: 'meta_description', category: 'seo', weight: 2, label: L('Meta description (50–160 characters)', 'Meta описание (50–160 знака)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const n = s.scan.seo.meta_description_length;
      return { status: n >= 50 && n <= 160 ? 'pass' : n ? 'warn' : 'fail', detail: n ? `${n} ${pick(lang, 'characters', 'знака')}` : pick(lang, 'Missing', 'Липсва') };
    },
  },
  {
    id: 'h1', category: 'seo', weight: 2, label: L('One H1 heading', 'Един H1 заглавие'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const n = s.scan.seo.h1_count;
      return { status: n === 1 ? 'pass' : n > 1 ? 'warn' : 'fail', detail: `${n} H1` };
    },
  },
  {
    id: 'alt', category: 'seo', weight: 1, label: L('Image alt text', 'Alt текст на изображенията'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const total = s.pages.reduce((a, p) => a + p.images, 0);
      const missing = s.pages.reduce((a, p) => a + p.images_without_alt, 0);
      if (!total) return { status: 'pass', detail: pick(lang, 'No images', 'Няма изображения') };
      const share = 1 - missing / total;
      return { status: share >= 0.9 ? 'pass' : share >= 0.6 ? 'warn' : 'fail', detail: pick(lang, `${missing} of ${total} images without alt`, `${missing} от ${total} изображения без alt`) };
    },
  },
  {
    id: 'local_schema', category: 'seo', weight: 2, label: L('LocalBusiness structured data', 'Структурирани данни LocalBusiness'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.seo.local_business_schema ? { status: 'pass', detail: s.scan.seo.json_ld_types.join(', ') } : { status: 'fail', detail: s.scan.seo.json_ld_types.length ? s.scan.seo.json_ld_types.join(', ') : pick(lang, 'No schema.org data found', 'Не са открити schema.org данни') };
    },
  },
  {
    id: 'sitemap', category: 'seo', weight: 1, label: L('XML sitemap', 'XML sitemap'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.sitemap ? { status: 'pass', detail: s.sitemap_url! } : { status: 'fail', detail: pick(lang, 'Not found', 'Не е открит') };
    },
  },
  {
    id: 'robots', category: 'seo', weight: 1, label: L('robots.txt', 'robots.txt'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.robots_txt ? { status: 'pass', detail: T[lang].yes } : { status: 'warn', detail: pick(lang, 'Not found', 'Не е открит') };
    },
  },
  {
    id: 'canonical_lang', category: 'seo', weight: 1, label: L('Canonical URL and language tag', 'Canonical адрес и езиков таг'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const ok = Number(s.scan.seo.canonical) + Number(!!s.scan.seo.lang);
      return { status: ok === 2 ? 'pass' : ok === 1 ? 'warn' : 'fail', detail: `canonical: ${s.scan.seo.canonical ? T[lang].yes : T[lang].no}, lang: ${s.scan.seo.lang ?? T[lang].no}` };
    },
  },
  {
    id: 'open_graph', category: 'seo', weight: 1, label: L('Social sharing tags (Open Graph)', 'Тагове за споделяне (Open Graph)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.seo.open_graph ? { status: 'pass', detail: T[lang].yes } : { status: 'warn', detail: pick(lang, 'Not found', 'Не са открити') };
    },
  },
  {
    id: 'seo_score', category: 'seo', weight: 2, label: L('Lighthouse SEO score', 'Lighthouse SEO оценка'),
    test: (e, lang) => {
      const p = e.pagespeed.state === 'observed' ? e.pagespeed.value! : null;
      if (!p || p.seo === null) return unknown(lang, e.pagespeed.note);
      return { status: p.seo >= 90 ? 'pass' : p.seo >= 70 ? 'warn' : 'fail', detail: `${p.seo}/100` };
    },
  },
  // -- technology ---------------------------------------------------------------
  {
    id: 'analytics', category: 'technology', weight: 3, label: L('Web analytics (GA4)', 'Уеб анализ (GA4)'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const a = s.scan.analytics;
      return a.ga4 ? { status: 'pass', detail: s.scan.ids.ga4.join(', ') || 'GA4' } : a.gtm ? { status: 'warn', detail: pick(lang, 'GTM present; GA4 may load through it (not verified)', 'Има GTM; GA4 може да се зарежда през него (не е проверено)') } : a.universal_analytics ? { status: 'warn', detail: pick(lang, 'Only Universal Analytics, retired by Google in 2023', 'Само Universal Analytics, спрян от Google през 2023') } : { status: 'fail', detail: pick(lang, 'Not detected on the homepage', 'Не е открит на началната страница') };
    },
  },
  {
    id: 'gtm', category: 'technology', weight: 1, label: L('Google Tag Manager', 'Google Tag Manager'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.analytics.gtm ? { status: 'pass', detail: s.scan.ids.gtm.join(', ') || 'GTM' } : { status: 'warn', detail: pick(lang, 'Not detected', 'Не е открит') };
    },
  },
  {
    id: 'meta_pixel', category: 'technology', weight: 2, label: L('Meta (Facebook) Pixel', 'Meta (Facebook) Pixel'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.analytics.meta_pixel ? { status: 'pass', detail: s.scan.ids.meta_pixel.join(', ') || 'Meta Pixel' } : { status: 'fail', detail: pick(lang, 'Not detected on the homepage', 'Не е открит на началната страница') };
    },
  },
  {
    id: 'ads_conversion', category: 'technology', weight: 2, label: L('Google Ads conversion tracking', 'Проследяване на конверсии в Google Ads'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      return s.scan.analytics.google_ads ? { status: 'pass', detail: s.scan.ids.google_ads.join(', ') || 'Google Ads' } : { status: 'fail', detail: pick(lang, 'Not detected (a tag alone cannot show whether ads run)', 'Не е открито (таг сам по себе си не показва дали има реклами)') };
    },
  },
  {
    id: 'chat', category: 'technology', weight: 1, label: L('Live chat or messaging', 'Чат или съобщения на живо'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const any = [...s.scan.chat, ...(s.scan.conversion.whatsapp ? ['WhatsApp'] : [])];
      return any.length ? { status: 'pass', detail: any.join(', ') } : { status: 'warn', detail: pick(lang, 'Not detected', 'Не е открит') };
    },
  },
  // -- Google Business Profile ----------------------------------------------------
  {
    id: 'gbp_claimed', category: 'gbp', weight: 3, label: L('Profile claimed by the owner', 'Профилът е потвърден от собственика'),
    test: (e, lang) =>
      e.listing.claimed === null ? unknown(lang) : e.listing.claimed ? { status: 'pass', detail: T[lang].yes } : { status: 'fail', detail: pick(lang, 'Listing shows "Claim this business"', 'Профилът не е потвърден') },
  },
  {
    id: 'gbp_phone', category: 'gbp', weight: 2, label: L('Phone number on the profile', 'Телефон в профила'),
    test: (e, lang) => (e.listing.has_phone ? { status: 'pass', detail: e.business.phone ?? T[lang].yes } : { status: 'fail', detail: pick(lang, 'Not shown', 'Не е посочен') }),
  },
  {
    id: 'gbp_website', category: 'gbp', weight: 2, label: L('Website on the profile', 'Уебсайт в профила'),
    test: (e, lang) => (e.listing.has_website ? { status: 'pass', detail: e.business.website_url! } : { status: 'fail', detail: pick(lang, 'Not shown', 'Не е посочен') }),
  },
  {
    id: 'gbp_hours', category: 'gbp', weight: 2, label: L('Opening hours', 'Работно време'),
    test: (e, lang) => (e.listing.opening_hours ? { status: 'pass', detail: e.listing.opening_hours.slice(0, 90) } : { status: 'fail', detail: pick(lang, 'Not shown', 'Не е посочено') }),
  },
  {
    id: 'gbp_categories', category: 'gbp', weight: 1, label: L('Business categories', 'Категории на бизнеса'),
    test: (e, lang) => {
      const n = e.listing.categories.length;
      return { status: n >= 2 ? 'pass' : n === 1 ? 'warn' : 'fail', detail: n ? e.listing.categories.slice(0, 4).join(', ') : pick(lang, 'None', 'Няма') };
    },
  },
  {
    id: 'gbp_photos', category: 'gbp', weight: 1, label: L('Photos and posts activity', 'Снимки и публикации'),
    test: (_e, lang) => unknown(lang, pick(lang, 'Not checked in this report', 'Не е проверено в този отчет')),
  },
  // -- reputation ---------------------------------------------------------------------
  {
    id: 'rating', category: 'reputation', weight: 3, label: L('Average rating', 'Средна оценка'),
    test: (e, lang) => {
      const r = e.listing.rating;
      if (r === null) return { status: 'fail', detail: pick(lang, 'No rating yet', 'Все още няма оценка') };
      return { status: r >= 4.5 ? 'pass' : r >= 4.0 ? 'warn' : 'fail', detail: `${r.toFixed(1)} ★` };
    },
  },
  {
    id: 'review_volume', category: 'reputation', weight: 3, label: L('Number of reviews vs. competitors', 'Брой отзиви спрямо конкурентите'),
    test: (e, lang) => {
      const n = e.listing.review_count ?? 0;
      const m = median(e.competitors.map((c) => c.review_count ?? 0));
      if (m === null) return { status: n >= 100 ? 'pass' : n >= 25 ? 'warn' : 'fail', detail: `${n}` };
      return { status: n >= m ? 'pass' : n >= m / 2 ? 'warn' : 'fail', detail: pick(lang, `${n} (competitor median ${Math.round(m)})`, `${n} (медиана при конкурентите ${Math.round(m)})`) };
    },
  },
  {
    id: 'review_replies', category: 'reputation', weight: 2, label: L('Owner replies to reviews', 'Отговори на собственика на отзиви'),
    test: (_e, lang) => unknown(lang, pick(lang, 'Individual reviews were not collected for this report', 'Отделните отзиви не са събрани за този отчет')),
  },
  // -- listings / NAP ---------------------------------------------------------------------
  {
    id: 'nap_phone', category: 'listings', weight: 2, label: L('Same phone on website and Google', 'Еднакъв телефон в сайта и в Google'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      if (!e.business.phone) return unknown(lang, pick(lang, 'No phone on the listing', 'Няма телефон в профила'));
      const want = digits(e.business.phone).slice(-9);
      const match = s.phones_on_site.some((p) => p.endsWith(want));
      return match ? { status: 'pass', detail: e.business.phone } : { status: 'fail', detail: pick(lang, `Listing phone ${e.business.phone} not found on the website pages read`, `Телефонът от профила ${e.business.phone} не е открит в прочетените страници`) };
    },
  },
  {
    id: 'nap_address', category: 'listings', weight: 2, label: L('Same address on website and Google', 'Еднакъв адрес в сайта и в Google'),
    test: (e, lang) => {
      const s = site(e);
      if (!s) return noSiteUnknown(e, lang);
      const text = s.page_text_sample.toLowerCase();
      const street = (e.business.street ?? '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
      const postal = (e.business.postal_code ?? '').toLowerCase();
      if (!street.length && !postal) return unknown(lang, pick(lang, 'No address on the listing', 'Няма адрес в профила'));
      const hits = street.filter((w) => text.includes(w)).length + (postal && text.includes(postal) ? 1 : 0);
      const need = street.length + (postal ? 1 : 0);
      return { status: hits === need ? 'pass' : hits > 0 ? 'warn' : 'fail', detail: e.business.address ?? '' };
    },
  },
  {
    id: 'directories', category: 'listings', weight: 2, label: L('Presence in online directories', 'Присъствие в онлайн директории'),
    test: (_e, lang) => unknown(lang, pick(lang, 'Directory listings were not checked for this report', 'Директориите не са проверени за този отчет')),
  },
];

const RECS: Record<string, { en: [string, string]; bg: [string, string]; impact: Recommendation['impact']; effort: Recommendation['effort']; horizon: 30 | 60 | 90; service: Record<Lang, string> }> = {
  site_exists: { en: ['Launch a professional website', 'Without a website the business depends entirely on third-party profiles and loses visitors who look for details, prices or booking.'], bg: ['Изграждане на професионален уебсайт', 'Без уебсайт бизнесът зависи изцяло от чужди профили и губи клиенти, които търсят информация, цени или резервация.'], impact: 'high', effort: 'high', horizon: 90, service: L('Website design & development', 'Изработка на уебсайт') },
  https: { en: ['Move the site to HTTPS', 'Browsers mark plain-HTTP sites "Not secure", which costs trust and rankings.'], bg: ['Преминаване към HTTPS', 'Браузърите маркират HTTP сайтовете като „Несигурни“, което коства доверие и позиции в Google.'], impact: 'high', effort: 'low', horizon: 30, service: L('Technical maintenance', 'Техническа поддръжка') },
  https_redirect: { en: ['Redirect every HTTP address to HTTPS', 'Visitors and search engines reaching the http:// version should land on the secure site.'], bg: ['Пренасочване на HTTP към HTTPS', 'Посетителите и търсачките, които отварят http:// версията, трябва да попадат на защитения сайт.'], impact: 'low', effort: 'low', horizon: 30, service: L('Technical maintenance', 'Техническа поддръжка') },
  mobile: { en: ['Make the website mobile-friendly', 'Most local searches happen on phones; a non-responsive site loses them and ranks lower.'], bg: ['Адаптиране на сайта за мобилни устройства', 'Повечето местни търсения са от телефон; неадаптиран сайт губи тези клиенти и се класира по-ниско.'], impact: 'high', effort: 'medium', horizon: 60, service: L('Website redesign', 'Редизайн на уебсайт') },
  performance: { en: ['Speed up the mobile site', 'Slow pages lose visitors before they load; speed is also a Google ranking signal.'], bg: ['Ускоряване на сайта за мобилни', 'Бавните страници губят посетители още преди да се заредят; скоростта е и фактор за класиране в Google.'], impact: 'high', effort: 'medium', horizon: 60, service: L('Performance optimisation', 'Оптимизация на скоростта') },
  lcp: { en: ['Shorten the main content load time (LCP)', 'Compress and resize the largest image, defer non-critical scripts.'], bg: ['Съкращаване на времето за зареждане на основното съдържание (LCP)', 'Компресиране на най-голямото изображение и отлагане на некритичните скриптове.'], impact: 'medium', effort: 'medium', horizon: 60, service: L('Performance optimisation', 'Оптимизация на скоростта') },
  cls: { en: ['Stop the layout from jumping while loading', 'Reserve space for images and banners so visitors do not mis-tap.'], bg: ['Стабилизиране на страницата при зареждане', 'Резервиране на място за изображения и банери, за да не се натиска грешно.'], impact: 'low', effort: 'low', horizon: 30, service: L('Performance optimisation', 'Оптимизация на скоростта') },
  cta: { en: ['Add clear calls to action', '"Call now", "Book online" or "Get a quote" above the fold turn visits into enquiries.'], bg: ['Добавяне на ясни призиви за действие', '„Обадете се“, „Резервирайте“ или „Поискайте оферта“ в горната част превръщат посещенията в запитвания.'], impact: 'high', effort: 'low', horizon: 30, service: L('Conversion optimisation', 'Оптимизация на конверсиите') },
  click_to_call: { en: ['Make the phone number tappable', 'A tel: link lets mobile visitors call in one tap.'], bg: ['Телефон с бързо обаждане', 'tel: връзка позволява на мобилните посетители да се обадят с едно докосване.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Conversion optimisation', 'Оптимизация на конверсиите') },
  contact_form: { en: ['Add a contact or online booking form', 'Some customers will not call; a form or booking widget captures them.'], bg: ['Форма за контакт или онлайн резервация', 'Част от клиентите не се обаждат; форма или система за резервации ги улавя.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Conversion optimisation', 'Оптимизация на конверсиите') },
  title: { en: ['Rewrite page titles', 'Titles of 10–65 characters with the service and town are what searchers see first.'], bg: ['Пренаписване на заглавията на страниците', 'Заглавия от 10–65 знака с услугата и града са първото, което виждат търсещите.'], impact: 'medium', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  meta_description: { en: ['Write meta descriptions', 'A 50–160 character description with a reason to click raises click-through from Google.'], bg: ['Meta описания на страниците', 'Описание от 50–160 знака с причина за клик увеличава кликванията от Google.'], impact: 'medium', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  h1: { en: ['Use one clear H1 per page', 'One H1 naming the service and town tells Google what the page is about.'], bg: ['Един ясен H1 на страница', 'Един H1 с услугата и града казва на Google за какво е страницата.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  alt: { en: ['Describe images with alt text', 'Alt text helps image search and accessibility.'], bg: ['Alt текст на изображенията', 'Alt текстът помага за търсенето по изображения и за достъпността.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  local_schema: { en: ['Add LocalBusiness structured data', 'Schema markup with name, address, phone and hours strengthens local rankings and rich results.'], bg: ['Структурирани данни LocalBusiness', 'Schema маркиране с име, адрес, телефон и работно време подсилва местното класиране.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  sitemap: { en: ['Publish an XML sitemap', 'A sitemap submitted to Search Console helps every page get indexed.'], bg: ['Публикуване на XML sitemap', 'Sitemap, подаден в Search Console, помага всяка страница да бъде индексирана.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  robots: { en: ['Add a robots.txt file', 'It guides crawlers and points them to the sitemap.'], bg: ['Добавяне на robots.txt', 'Насочва търсачките и им показва sitemap-а.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  canonical_lang: { en: ['Set canonical URLs and the page language', 'Prevents duplicate-content issues and serves the right language.'], bg: ['Canonical адреси и език на страницата', 'Предотвратява дублирано съдържание и показва правилния език.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  open_graph: { en: ['Add social sharing tags', 'Open Graph tags make shared links show the right title and image.'], bg: ['Тагове за споделяне в социалните мрежи', 'Open Graph таговете показват правилно заглавие и снимка при споделяне.'], impact: 'low', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  seo_score: { en: ['Fix the Lighthouse SEO issues', 'The listed technical issues hold rankings back and are quick to fix.'], bg: ['Отстраняване на SEO проблемите от Lighthouse', 'Изброените технически проблеми задържат класирането и се оправят бързо.'], impact: 'medium', effort: 'low', horizon: 30, service: L('SEO', 'SEO') },
  analytics: { en: ['Install Google Analytics 4', 'Without analytics there is no way to know where customers come from or what they do.'], bg: ['Инсталиране на Google Analytics 4', 'Без анализ няма как да се знае откъде идват клиентите и какво правят.'], impact: 'high', effort: 'low', horizon: 30, service: L('Analytics & tracking', 'Анализ и проследяване') },
  gtm: { en: ['Manage tags with Google Tag Manager', 'One container for analytics, pixels and conversions, changed without touching the site.'], bg: ['Управление на таговете с Google Tag Manager', 'Един контейнер за анализ, пиксели и конверсии, без промени по сайта.'], impact: 'low', effort: 'low', horizon: 30, service: L('Analytics & tracking', 'Анализ и проследяване') },
  meta_pixel: { en: ['Install the Meta Pixel', 'Needed to measure and retarget Facebook and Instagram advertising.'], bg: ['Инсталиране на Meta Pixel', 'Необходим за измерване и ретаргетинг на рекламите във Facebook и Instagram.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Paid social advertising', 'Реклама в социалните мрежи') },
  ads_conversion: { en: ['Set up Google Ads conversion tracking', 'Without it ad spend cannot be tied to calls, forms or bookings.'], bg: ['Проследяване на конверсии в Google Ads', 'Без него рекламният бюджет не може да се свърже с обаждания, запитвания и резервации.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Google Ads management', 'Управление на Google Ads') },
  chat: { en: ['Offer chat or messaging', 'A chat, Messenger or WhatsApp button catches visitors who will not call.'], bg: ['Чат или съобщения', 'Чат, Messenger или WhatsApp бутон улавя посетителите, които не се обаждат.'], impact: 'low', effort: 'low', horizon: 60, service: L('Conversion optimisation', 'Оптимизация на конверсиите') },
  gbp_claimed: { en: ['Claim and verify the Google Business Profile', 'An unclaimed profile can be edited by anyone and cannot reply to reviews.'], bg: ['Потвърждаване на Google Business Profile', 'Непотвърден профил може да бъде редактиран от всеки и не може да отговаря на отзиви.'], impact: 'high', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  gbp_phone: { en: ['Add the phone number to the Google profile', 'Calls from Maps are often the first contact.'], bg: ['Телефон в Google профила', 'Обажданията от Google Maps често са първият контакт.'], impact: 'high', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  gbp_website: { en: ['Link the website from the Google profile', 'Sends profile visitors to the site.'], bg: ['Връзка към сайта в Google профила', 'Препраща посетителите на профила към сайта.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  gbp_hours: { en: ['Publish opening hours', 'Missing hours make customers choose a competitor who shows them.'], bg: ['Публикуване на работно време', 'Липсващото работно време кара клиентите да изберат конкурент.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  gbp_categories: { en: ['Add secondary categories', 'Extra relevant categories make the profile show for more searches.'], bg: ['Допълнителни категории', 'Допълнителните категории показват профила в повече търсения.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  rating: { en: ['Improve the average rating', 'Address recurring complaints and invite happy customers to review.'], bg: ['Подобряване на средната оценка', 'Решаване на повтарящите се оплаквания и покана към доволните клиенти да оставят отзив.'], impact: 'high', effort: 'medium', horizon: 90, service: L('Reputation management', 'Управление на репутацията') },
  review_volume: { en: ['Run a review generation programme', 'A steady flow of new reviews closes the gap with competitors and lifts Maps rankings.'], bg: ['Програма за събиране на отзиви', 'Постоянен приток на нови отзиви затваря разликата с конкурентите и повишава класирането в Maps.'], impact: 'high', effort: 'medium', horizon: 60, service: L('Reputation management', 'Управление на репутацията') },
  nap_phone: { en: ['Use the same phone number everywhere', 'Inconsistent phone numbers confuse customers and weaken local rankings.'], bg: ['Еднакъв телефон навсякъде', 'Различните телефони объркват клиентите и отслабват местното класиране.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
  nap_address: { en: ['Show the same address on the website as on Google', 'Name, address and phone should match exactly across the web.'], bg: ['Еднакъв адрес в сайта и в Google', 'Името, адресът и телефонът трябва да съвпадат навсякъде в интернет.'], impact: 'medium', effort: 'low', horizon: 30, service: L('Local SEO', 'Локално SEO') },
};

export function score(e: AuditEvidence): AuditScore {
  const lang: Lang = e.language;
  const criteria: Criterion[] = DEFS.map((d) => {
    const { status, detail } = d.test(e, lang);
    return { id: d.id, category: d.category, label: d.label[lang], status, detail, weight: d.weight };
  });
  const categories = (Object.keys(CATEGORY_WEIGHTS) as CategoryId[]).map((id) => {
    const own = criteria.filter((c) => c.category === id);
    const known = own.filter((c) => c.status !== 'unknown');
    const possible = known.reduce((a, c) => a + c.weight, 0);
    const earned = known.reduce((a, c) => a + (c.status === 'pass' ? c.weight : c.status === 'warn' ? c.weight / 2 : 0), 0);
    return { id, label: categoryLabel(id, lang), score: possible ? Math.round((100 * earned) / possible) : null, weight: CATEGORY_WEIGHTS[id], known: known.length, total: own.length };
  });
  const scored = categories.filter((c) => c.score !== null);
  const weight = scored.reduce((a, c) => a + c.weight, 0);
  const overall = weight ? Math.round(scored.reduce((a, c) => a + c.score! * c.weight, 0) / weight) : null;
  const order = { high: 0, medium: 1, low: 2 } as const;
  // Within an impact level, what weighs most in the score comes first.
  const weightOf = (id: string) => {
    const c = criteria.find((x) => x.id === id)!;
    return CATEGORY_WEIGHTS[c.category] * c.weight;
  };
  const recommendations = criteria
    .filter((c) => (c.status === 'fail' || c.status === 'warn') && RECS[c.id])
    .map((c) => {
      const r = RECS[c.id];
      const [title, why] = r[lang];
      return {
        id: c.id,
        title,
        why,
        impact: c.status === 'warn' && r.impact === 'high' ? ('medium' as const) : r.impact,
        effort: r.effort,
        horizon: r.horizon,
        quick_win: r.effort === 'low',
        service: r.service[lang],
      };
    })
    .sort((a, b) => order[a.impact] - order[b.impact] || weightOf(b.id) - weightOf(a.id) || a.horizon - b.horizon);
  return { overall, categories, criteria, recommendations };
}
