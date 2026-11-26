/**
 * What a business's homepage shows about its marketing stack and basics,
 * read from the HTML and headers enrichment already fetched -- no extra
 * request. Every value is an observation of that one page at that time:
 * a tag that is absent here may still load from another page or a consent
 * manager, so absence is "not detected", never "verified absent".
 */
import { load } from 'cheerio';

export interface SiteScan {
  url: string;
  scanned_at: number;
  https: boolean;
  hsts: boolean;
  load_ms: number | null;
  page_kb: number;
  server: string | null;
  cms: string | null;
  builders: string[];
  analytics: {
    ga4: boolean;
    universal_analytics: boolean;
    gtm: boolean;
    meta_pixel: boolean;
    google_ads: boolean;
    tiktok_pixel: boolean;
    linkedin_insight: boolean;
    hotjar: boolean;
    clarity: boolean;
  };
  ids: { ga4: string[]; gtm: string[]; google_ads: string[]; meta_pixel: string[] };
  chat: string[];
  booking: string[];
  call_tracking: string[];
  seo: {
    title: string | null;
    title_length: number;
    meta_description_length: number;
    h1_count: number;
    lang: string | null;
    canonical: boolean;
    open_graph: boolean;
    json_ld_types: string[];
    local_business_schema: boolean;
    images: number;
    images_without_alt: number;
    internal_links: number;
  };
  mobile_viewport: boolean;
  conversion: { tel_links: number; mailto_links: number; forms: number; cta_buttons: number; whatsapp: boolean };
}

const has = (html: string, ...needles: string[]) => needles.some((n) => html.includes(n));
const ids = (html: string, re: RegExp, max = 5) => [...new Set(html.match(re) ?? [])].slice(0, max);

const CMS: [string, string[]][] = [
  ['WordPress', ['/wp-content/', '/wp-includes/', 'content="WordPress']],
  ['Wix', ['static.wixstatic.com', 'wix-bolt', 'X-Wix-']],
  ['Squarespace', ['static1.squarespace.com', 'squarespace-cdn.com']],
  ['Shopify', ['cdn.shopify.com', 'Shopify.theme']],
  ['Webflow', ['data-wf-site', 'webflow.js', 'assets.website-files.com']],
  ['GoDaddy Website Builder', ['img1.wsimg.com', 'websites.godaddy.com']],
  ['Duda', ['irp.cdn-website.com', 'dudamobile', 'd32hwlnfiv2gyn.cloudfront.net']],
  ['Weebly', ['weebly.com', 'editmysite.com']],
  ['Joomla', ['/media/jui/', 'content="Joomla']],
  ['Drupal', ['Drupal.settings', '/sites/default/files/', 'data-drupal-']],
  ['HubSpot CMS', ['hs-sites.com', 'hubspotusercontent']],
  ['Next.js', ['__NEXT_DATA__', '/_next/static/']],
];
const BUILDERS: [string, string[]][] = [
  ['Elementor', ['elementor-']],
  ['Divi', ['et_pb_', 'Divi']],
  ['WooCommerce', ['woocommerce']],
  ['Yoast SEO', ['yoast-schema-graph', 'Yoast SEO']],
];
const CHAT: [string, string[]][] = [
  ['Intercom', ['widget.intercom.io', 'intercomSettings']],
  ['Drift', ['js.driftt.com']],
  ['Tawk.to', ['embed.tawk.to']],
  ['LiveChat', ['cdn.livechatinc.com']],
  ['Zendesk', ['static.zdassets.com']],
  ['HubSpot chat', ['js.usemessages.com', 'js.hs-scripts.com']],
  ['Tidio', ['code.tidio.co']],
  ['Crisp', ['client.crisp.chat']],
  ['Podium', ['connect.podium.com', 'podium-widget']],
  ['Birdeye', ['birdeye.com/embed']],
  ['Messenger', ['xfbml.customerchat', 'm.me/']],
];
const BOOKING: [string, string[]][] = [
  ['Calendly', ['calendly.com']],
  ['Acuity', ['acuityscheduling.com']],
  ['Square Appointments', ['squareup.com/appointments']],
  ['OpenTable', ['opentable.com']],
  ['Resy', ['resy.com']],
  ['Zocdoc', ['zocdoc.com']],
  ['Vagaro', ['vagaro.com']],
  ['Booksy', ['booksy.com']],
  ['Mindbody', ['mindbodyonline.com']],
  ['Housecall Pro', ['housecallpro.com']],
];
const CALL_TRACKING: [string, string[]][] = [
  ['CallRail', ['cdn.callrail.com']],
  ['WhatConverts', ['whatconverts.com']],
  ['CallTrackingMetrics', ['tctm.co', 'calltrackingmetrics']],
];
const CTA = /\b(book|schedule|appointment|call now|call us|contact us|get (a )?quote|free (estimate|quote|consultation)|request|order online|reserve|запази|резерв|обадете|свържете|поръчай|запитване)\b/i;

const found = (html: string, table: [string, string[]][]) =>
  table.filter(([, needles]) => has(html, ...needles)).map(([name]) => name);

export function scanSite(
  html: string,
  url: URL,
  headers: Record<string, string> = {},
  elapsedMs: number | null = null,
  now = Date.now(),
): SiteScan {
  const $ = load(html);
  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          const t = (node as Record<string, unknown>)['@type'];
          for (const v of Array.isArray(t) ? t : [t]) if (typeof v === 'string') jsonLdTypes.push(v);
          const graph = (node as Record<string, unknown>)['@graph'];
          if (graph) walk(graph);
        }
      };
      walk(JSON.parse($(el).text()));
    } catch {
      // malformed JSON-LD is reported as absent types
    }
  });
  const types = [...new Set(jsonLdTypes)].slice(0, 20);
  const localTypes = /LocalBusiness|Restaurant|Dentist|Attorney|LegalService|MedicalBusiness|HomeAndConstructionBusiness|Store|AutoRepair|BeautySalon|HealthAndBeautyBusiness|ProfessionalService|FoodEstablishment|Plumber|Electrician|RoofingContractor|HVACBusiness|RealEstateAgent|AccountingService|InsuranceAgency|Physician|Hotel|LodgingBusiness/;
  const images = $('img');
  const host = url.hostname.replace(/^www\./, '');
  let internal = 0;
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') ?? '');
    try {
      const target = new URL(href, url);
      if (target.hostname.replace(/^www\./, '') === host && target.protocol.startsWith('http')) internal++;
    } catch {
      // ignore unparsable links
    }
  });
  let cta = 0;
  $('a, button, input[type="submit"]').each((_, el) => {
    const text = ($(el).text() || String($(el).attr('value') ?? '')).trim().slice(0, 80);
    if (text && CTA.test(text)) cta++;
  });
  const title = $('title').first().text().trim() || null;
  const description = $('meta[name="description" i]').attr('content')?.trim() ?? '';
  const cms = found(html, CMS);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!cms.length && /wix/i.test(lower['x-wix-request-id'] ?? '')) cms.push('Wix');
  return {
    url: url.href,
    scanned_at: now,
    https: url.protocol === 'https:',
    hsts: Boolean(lower['strict-transport-security']),
    load_ms: elapsedMs,
    page_kb: Math.round(Buffer.byteLength(html) / 1024),
    server: (lower['server'] || lower['x-powered-by'] || '').slice(0, 60) || null,
    cms: cms[0] ?? null,
    builders: found(html, BUILDERS),
    analytics: {
      ga4: /gtag\/js\?id=G-|['"]G-[A-Z0-9]{6,12}['"]/.test(html),
      universal_analytics: /['"]UA-\d{4,10}-\d{1,4}['"]/.test(html),
      gtm: has(html, 'googletagmanager.com/gtm.js', 'googletagmanager.com/ns.html'),
      meta_pixel: has(html, 'connect.facebook.net') && /fbq\(\s*['"]init/.test(html) || has(html, 'fbevents.js'),
      google_ads: /['"]AW-\d{6,12}['"]|googleadservices\.com\/pagead\/conversion|google_conversion_id/.test(html),
      tiktok_pixel: has(html, 'analytics.tiktok.com'),
      linkedin_insight: has(html, 'snap.licdn.com', '_linkedin_partner_id'),
      hotjar: has(html, 'static.hotjar.com'),
      clarity: has(html, 'clarity.ms/tag'),
    },
    ids: {
      ga4: ids(html, /\bG-[A-Z0-9]{6,12}\b/g),
      gtm: ids(html, /\bGTM-[A-Z0-9]{4,10}\b/g),
      google_ads: ids(html, /\bAW-\d{6,12}\b/g),
      meta_pixel: [...new Set([...html.matchAll(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/g)].map((m) => m[1]))].slice(0, 5),
    },
    chat: found(html, CHAT),
    booking: found(html, BOOKING),
    call_tracking: found(html, CALL_TRACKING),
    seo: {
      title,
      title_length: title?.length ?? 0,
      meta_description_length: description.length,
      h1_count: $('h1').length,
      lang: $('html').attr('lang')?.trim() || null,
      canonical: $('link[rel="canonical" i]').length > 0,
      open_graph: $('meta[property^="og:"]').length > 0,
      json_ld_types: types,
      local_business_schema: types.some((t) => localTypes.test(t)),
      images: images.length,
      images_without_alt: images.filter((_, el) => !($(el).attr('alt') ?? '').trim()).length,
      internal_links: internal,
    },
    mobile_viewport: /width\s*=\s*device-width/i.test($('meta[name="viewport" i]').attr('content') ?? ''),
    conversion: {
      tel_links: $('a[href^="tel:" i]').length,
      mailto_links: $('a[href^="mailto:" i]').length,
      forms: $('form').length,
      cta_buttons: cta,
      whatsapp: has(html, 'wa.me/', 'api.whatsapp.com'),
    },
  };
}

/** The scan as flat fields for a lead record: what a list filters on. */
export function scanFields(scan: SiteScan | null | undefined): Record<string, unknown> {
  if (!scan) return { site_scanned: false };
  return {
    site_scanned: true,
    site_https: scan.https,
    site_mobile: scan.mobile_viewport,
    site_cms: scan.cms,
    site_ga4: scan.analytics.ga4,
    site_gtm: scan.analytics.gtm,
    site_meta_pixel: scan.analytics.meta_pixel,
    site_google_ads: scan.analytics.google_ads,
    site_chat: scan.chat.length > 0,
    site_booking: scan.booking.length > 0,
    site_load_ms: scan.load_ms,
    site_local_schema: scan.seo.local_business_schema,
    site_scanned_at: new Date(scan.scanned_at).toISOString(),
  };
}
