import { scanFields, scanSite } from './site-scan';

const page = `<!doctype html><html lang="en"><head>
<title>Bright Smile Dental | Family Dentist in Austin</title>
<meta name="description" content="Family and cosmetic dentistry in Austin, TX. Same-day appointments.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://brightsmile.example/">
<meta property="og:title" content="Bright Smile Dental">
<link rel="stylesheet" href="/wp-content/themes/x/style.css">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>
<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-K9P2Q1');</script>
<script src="https://www.googletagmanager.com/gtm.js?id=GTM-K9P2Q1"></script>
<script>!function(f,b,e,v){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '1234567890123');</script>
<script src="https://embed.tawk.to/abc/default"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Bright Smile Dental"}</script>
</head><body>
<h1>Your Austin dentist</h1>
<img src="a.jpg" alt="Office"><img src="b.jpg">
<a href="/services">Services</a><a href="https://brightsmile.example/about">About</a><a href="https://other.example/">x</a>
<a href="tel:+15125550100">(512) 555-0100</a>
<a class="btn" href="/book">Book an appointment</a>
<form action="/contact"><input type="submit" value="Request a quote"></form>
</body></html>`;

test('a homepage scan reads the stack, SEO basics and conversion paths', () => {
  const scan = scanSite(page, new URL('https://brightsmile.example/'), { Server: 'nginx', 'strict-transport-security': 'max-age=1' }, 840, 1);
  expect(scan).toMatchObject({
    https: true,
    hsts: true,
    load_ms: 840,
    server: 'nginx',
    cms: 'WordPress',
    mobile_viewport: true,
    chat: ['Tawk.to'],
    analytics: { ga4: true, gtm: true, meta_pixel: true, google_ads: false, universal_analytics: false },
    ids: { ga4: ['G-ABC123XYZ'], gtm: ['GTM-K9P2Q1'], meta_pixel: ['1234567890123'] },
    seo: {
      title_length: 46,
      h1_count: 1,
      lang: 'en',
      canonical: true,
      open_graph: true,
      json_ld_types: ['Dentist'],
      local_business_schema: true,
      images: 2,
      images_without_alt: 1,
      internal_links: 3,
    },
    conversion: { tel_links: 1, forms: 1, cta_buttons: 2, whatsapp: false },
  });
  expect(scan.seo.meta_description_length).toBeGreaterThan(40);
});

test('a bare page is reported as not detected, and a lead without a scan says so', () => {
  const scan = scanSite('<html><body><p>Hello</p></body></html>', new URL('http://plain.example/'));
  expect(scan).toMatchObject({
    https: false,
    cms: null,
    mobile_viewport: false,
    analytics: { ga4: false, gtm: false, meta_pixel: false },
    seo: { title: null, h1_count: 0, json_ld_types: [], local_business_schema: false },
  });
  expect(scanFields(null)).toEqual({ site_scanned: false });
  expect(scanFields(scan)).toMatchObject({ site_scanned: true, site_https: false, site_meta_pixel: false });
});
