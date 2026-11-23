import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import {
  isValidEmail,
  normalizeEmail,
  normalizeSocialUrl,
  platformOf,
} from '../app/extractors';
import type { JobPlatform } from './jobs.types';

export const SCHEMA_VERSION = 1;
export const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const clean = (value: unknown, max = 240) =>
  typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, max) || undefined
    : undefined;
export const searchText = (value: string) =>
  value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const numberIn = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && value >= min && value <= max ? value : undefined;

export function publicUrl(value: unknown): string | undefined {
  const text = clean(value, 2048);
  if (!text || (typeof value === 'string' && value.length > 2048))
    return undefined;
  try {
    const url = new URL(
      /^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`,
    );
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    url.hash = '';
    return url.href.length <= 2048 ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface LeadContact {
  type: 'email' | 'phone' | 'social';
  value: string;
  normalized: string;
  source_url?: string;
  observed_at: number;
  last_verified_at?: number;
}

export interface LeadSource {
  kind:
    | 'listing'
    | 'website_contact'
    | 'website_technology'
    | 'directory_nap'
    | 'review'
    | 'audit_observation';
  platform: string;
  url?: string;
  observed_at: number;
  quality: 'observed' | 'uncertain';
  availability: 'public' | 'unknown';
  fields: Record<string, unknown>;
}

export interface LeadProfile {
  schema_version: number;
  id: string;
  name: string;
  categories?: string[];
  website_url?: string;
  domain?: string;
  country_code?: string;
  city?: string;
  region?: string;
  municipality?: string;
  postal_code?: string;
  street?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  platform?: JobPlatform;
  place_id?: string;
  listing_url?: string;
  review_url?: string;
  rating?: number;
  review_count?: number;
  opening_hours?: string;
  created_at: number;
  updated_at: number;
}

export type LeadSnapshot = LeadProfile & {
  sources: LeadSource[];
  contacts: LeadContact[];
  enrichment?: { status: string; attempted_urls: string[]; error?: string };
};

const values = (value: unknown) =>
  (Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : []
  )
    .map((item) => clean(item, 300))
    .filter(Boolean)
    .slice(0, 8);

// Restrict automated email collection to shared organizational mailboxes.
const SHARED_MAILBOX =
  /^(?:info|contact(?:o|s)?|hello|office|sales|support|service|enquiries|inquiries|admin|booking[s]?|reservations|reception|team|business|marketing|press|help|accounts|orders|general|mail|hi|kontakt|boekingen)(?:[+._-][\w-]+)?$/i;

export function observedContacts(
  raw: Record<string, unknown>,
  sourceUrl: string | undefined,
  now: number,
  country?: CountryCode,
): LeadContact[] {
  const contacts = new Map<string, LeadContact>();
  const add = (
    type: LeadContact['type'],
    value: string,
    normalized: string,
  ) => {
    if (normalized)
      contacts.set(`${type}:${normalized}`, {
        type,
        value,
        normalized,
        source_url: sourceUrl,
        observed_at: now,
      });
  };
  for (const email of [...values(raw.email), ...values(raw.emails)]) {
    const normalized = normalizeEmail(email);
    if (
      isValidEmail(normalized) &&
      SHARED_MAILBOX.test(normalized.split('@')[0])
    )
      add('email', email, normalized);
  }
  for (const phone of [...values(raw.phone), ...values(raw.phones)]) {
    const parsed = parsePhoneNumberFromString(phone, country);
    const digits = phone.replace(/[^\d]/g, '');
    if (parsed?.isValid()) add('phone', phone, parsed.number);
    else if (digits.length >= 7 && digits.length <= 15)
      add('phone', phone, phone.startsWith('+') ? `+${digits}` : digits);
  }
  for (const social of values(raw.socials)) {
    if (!publicUrl(social) || !platformOf(social)) continue;
    const normalized = normalizeSocialUrl(social);
    if (
      normalized &&
      !/linkedin\.com\/in\/|facebook\.com\/profile\.php|t\.me\//i.test(
        normalized,
      )
    ) {
      add('social', social, normalized);
    }
  }
  return [...contacts.values()].slice(0, 12);
}

export function storeContacts(
  db: DatabaseSync,
  leadId: string,
  contacts: LeadContact[],
) {
  const save =
    db.prepare(`INSERT INTO lead_contacts(lead_id,type,normalized,source_url,value,observed_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(lead_id,type,normalized,source_url)
    DO UPDATE SET value=excluded.value, observed_at=excluded.observed_at`);
  for (const contact of contacts) {
    save.run(
      leadId,
      contact.type,
      contact.normalized,
      contact.source_url || '',
      contact.value,
      contact.observed_at,
    );
  }
}

export function storeSource(
  db: DatabaseSync,
  jobId: string,
  leadId: string,
  source: LeadSource,
) {
  db.prepare(
    'INSERT INTO lead_sources(lead_id,job_id,platform,url,observed_at,evidence) VALUES(?,?,?,?,?,?)',
  ).run(
    leadId,
    jobId,
    source.platform,
    source.url ?? null,
    source.observed_at,
    JSON.stringify(source),
  );
}

export function ingestLead(
  db: DatabaseSync,
  jobId: string,
  platform: JobPlatform,
  raw: Record<string, unknown>,
  position: number,
  now: number,
): LeadSnapshot | undefined {
  const name = clean(raw.title ?? raw.name);
  if (!name) return;
  const address = clean(raw.address);
  const city = clean(raw.city);
  const country = clean(raw.country_code, 2)?.toUpperCase() as
    | CountryCode
    | undefined;
  const website = publicUrl(raw.website);
  const domain = website && new URL(website).hostname.replace(/^www\./, '');
  const listing = publicUrl(raw.maps_url);
  const rawPlaceId = clean(raw.place_id ?? raw.datafid ?? raw.cid);
  const placeId =
    rawPlaceId && !/^(?:undefined|null|nan)$/i.test(rawPlaceId)
      ? rawPlaceId
      : undefined;
  const latitude = numberIn(raw.latitude, -90, 90);
  const longitude = numberIn(raw.longitude, -180, 180);
  const postal = clean(raw.postal_code, 32);
  const street = clean(raw.street);
  // Require street-level location for fallback so branches in one city stay distinct.
  const streetLevel = address && /\p{N}/u.test(street || address);
  const fallback =
    domain && streetLevel
      ? digest(
          JSON.stringify(
            [
              domain,
              name,
              address,
              city || '',
              postal || '',
              country || '',
            ].map(searchText),
          ),
        )
      : null;
  let id =
    placeId &&
    (db
      .prepare(
        'SELECT lead_id FROM provider_ids WHERE platform=? AND place_id=?',
      )
      .get(platform, placeId)?.lead_id as string | undefined);
  if (!id && fallback) {
    const candidates = db
      .prepare('SELECT id FROM leads WHERE fallback_key=? LIMIT 2')
      .all(fallback);
    if (candidates.length === 1) {
      const candidate = String(candidates[0].id);
      const conflict =
        placeId &&
        db
          .prepare('SELECT 1 FROM provider_ids WHERE lead_id=? AND platform=?')
          .get(candidate, platform);
      if (!conflict) id = candidate;
    }
  }
  id ||= randomUUID();

  // First occurrence wins within a job. Later jobs can update the canonical profile.
  if (
    db
      .prepare('SELECT 1 FROM job_leads WHERE job_id=? AND lead_id=?')
      .get(jobId, id)
  )
    return;
  const fields = {
    name,
    address,
    city,
    region: clean(raw.state),
    country_code: country,
    municipality: clean(raw.municipality),
    postal_code: postal,
    street,
    website_url: website,
    domain,
    platform,
    place_id: placeId,
    listing_url: listing,
    review_url: publicUrl(raw.review_url),
    latitude: latitude === 0 && longitude === 0 ? undefined : latitude,
    longitude: latitude === 0 && longitude === 0 ? undefined : longitude,
    rating: numberIn(raw.rating, 0, 5),
    review_count: numberIn(raw.review_count, 0, Number.MAX_SAFE_INTEGER),
    opening_hours: clean(raw.opening_hours, 500),
    categories: values(raw.categories),
  };
  const previous = db
    .prepare('SELECT profile FROM leads WHERE id=?')
    .get(id)?.profile;
  const prior = previous
    ? (JSON.parse(String(previous)) as LeadProfile)
    : undefined;
  const profile = {
    schema_version: SCHEMA_VERSION,
    id,
    ...fields,
    created_at: prior?.created_at ?? now,
    updated_at: now,
  };
  const canonical = {
    ...prior,
    ...Object.fromEntries(
      Object.entries(profile).filter(
        ([, value]) =>
          value !== undefined && (!Array.isArray(value) || value.length > 0),
      ),
    ),
  } as unknown as LeadProfile;
  db.prepare(
    `INSERT INTO leads(id,fallback_key,name,search_text,profile,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET fallback_key=coalesce(excluded.fallback_key,leads.fallback_key), name=excluded.name,
    search_text=excluded.search_text,profile=excluded.profile,updated_at=excluded.updated_at`,
  ).run(
    id,
    fallback,
    name,
    searchText(
      [
        name,
        canonical.domain,
        canonical.address,
        canonical.city,
        ...(canonical.categories || []),
      ]
        .filter(Boolean)
        .join(' '),
    ),
    JSON.stringify(canonical),
    profile.created_at,
    now,
  );
  if (placeId)
    db.prepare('INSERT OR IGNORE INTO provider_ids VALUES(?,?,?)').run(
      platform,
      placeId,
      id,
    );
  const contacts = observedContacts(
    raw,
    listing,
    now,
    country && isSupportedCountry(country) ? country : undefined,
  );
  const source: LeadSource = {
    kind: 'listing',
    platform,
    url: listing,
    observed_at: now,
    quality: listing ? 'observed' : 'uncertain',
    availability: listing ? 'public' : 'unknown',
    fields: {
      ...fields,
      raw_name:
        typeof raw.title === 'string' ? raw.title.slice(0, 240) : undefined,
      raw_website:
        typeof raw.website === 'string' && website
          ? raw.website.slice(0, 2048)
          : undefined,
      labels: clean(raw.labels, 300),
      claimed: typeof raw.claimed === 'boolean' ? raw.claimed : undefined,
      services: clean(raw.services, 300),
      main_category: clean(raw.main_category),
      public_contacts: contacts.map(({ type, value }) => ({ type, value })),
    },
  };
  storeSource(db, jobId, id, source);
  storeContacts(db, id, contacts);
  const snapshot = { ...profile, sources: [source], contacts };
  db.prepare('INSERT INTO job_leads VALUES(?,?,?,?,?)').run(
    jobId,
    id,
    position,
    JSON.stringify(snapshot),
    searchText(
      [name, domain, address, city, ...fields.categories]
        .filter(Boolean)
        .join(' '),
    ),
  );
  return snapshot;
}
