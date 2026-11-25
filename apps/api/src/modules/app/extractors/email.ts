import { EXCLUDED_EMAIL_DOMAINS } from '@/common';
import { RawPageData } from './types';

// Stricter than the legacy pattern: no spaces inside, sane local/domain chars,
// TLD between 2 and 24 chars.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}/g;

// File extensions that look like emails after sloppy matching (e.g. logo@2x.png).
const FILE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|ico)$/i;

// Local parts that indicate a "good" role address, ordered by priority.
const PRIORITY_LOCALPARTS = [
  'info',
  'contact',
  'contacts',
  'hello',
  'sales',
  'office',
  'support',
  'admin',
  'mail',
];

// A bound on the text one page can make this read (bodies are capped at
// 512 KB before parsing, so it is rarely reached).
const MAX_TEXT_CHARS = 600_000;

/**
 * Decode common textual obfuscations: "name (at) domain (dot) com".
 * Conservative — only collapses the well-known tokens.
 */
export function deobfuscate(text: string): string {
  // Collapse whitespace first, in one linear pass. `\s+dot\s+` straight on
  // page text is quadratic in a long whitespace run: every start inside the
  // run re-scans it to the end. One real page cost ~30 s of CPU per visit and
  // froze the whole backend, enrichment and the worker's check-ins with it.
  return text
    .slice(0, MAX_TEXT_CHARS)
    .replace(/\s+/g, ' ')
    .replace(/ ?[([{] ?at ?[)\]}] ?/gi, '@')
    .replace(/ at /gi, '@')
    .replace(/ ?[([{] ?dot ?[)\]}] ?/gi, '.')
    .replace(/ dot /gi, '.');
}


export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '').replace(/^mailto:/, '');
}

export function isValidEmail(email: string): boolean {
  if (!email.includes('@')) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  if (!domain.includes('.')) return false;
  if (FILE_EXTENSIONS.test(email)) return false;
  if (/\.\./.test(email)) return false; // consecutive dots
  if (email.startsWith('.') || local.endsWith('.')) return false;
  // basic shape re-check
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,24}$/.test(email);
}

function isExcluded(email: string): boolean {
  const domain = email.split('@')[1] || '';
  return EXCLUDED_EMAIL_DOMAINS.some((d) => domain.includes(d));
}

/** mailto: hrefs are the most reliable source — collect them first. */
function emailsFromHrefs(hrefs: string[]): string[] {
  return hrefs
    .filter((h) => h.toLowerCase().startsWith('mailto:'))
    .map((h) => normalizeEmail(decodeURIComponent(h.slice('mailto:'.length).split('?')[0])));
}

/** Pull "email" fields out of schema.org / JSON-LD blocks. */
function emailsFromJsonLd(blocks: string[]): string[] {
  const found: string[] = [];
  for (const block of blocks) {
    try {
      const json = JSON.parse(block);
      const walk = (node: unknown): void => {
        if (!node) return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node === 'object') {
          for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
            if (key.toLowerCase() === 'email' && typeof value === 'string') {
              found.push(normalizeEmail(value));
            } else {
              walk(value);
            }
          }
        }
      };
      walk(json);
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return found;
}

function emailsFromText(text: string): string[] {
  const decoded = deobfuscate(text);
  const matches = decoded.match(EMAIL_RE) || [];
  return matches.map(normalizeEmail);
}

/**
 * Extract every distinct, valid, non-excluded email from a page.
 * Order reflects source reliability: mailto: > JSON-LD > visible text.
 */
export function extractEmails(raw: RawPageData): string[] {
  const ordered = [
    ...emailsFromHrefs(raw.hrefs),
    ...emailsFromJsonLd(raw.jsonLd),
    ...emailsFromText(raw.text),
  ];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const email of ordered) {
    if (!isValidEmail(email)) continue;
    if (isExcluded(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

/** Pick the most "contactable" address: role addresses win over personal ones. */
export function bestEmail(emails: string[]): string | undefined {
  if (emails.length === 0) return undefined;
  for (const localpart of PRIORITY_LOCALPARTS) {
    const match = emails.find((e) => e.split('@')[0] === localpart);
    if (match) return match;
  }
  return emails[0];
}
