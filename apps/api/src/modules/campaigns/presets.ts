/** Category lists a campaign can name instead of spelling categories out.
 * Searches read "<category> in <location>", so these are the plural nouns a
 * person types into Google Maps; Maps understands them in English for any
 * country, and the campaign's language decides what language the results
 * (addresses, categories, hours) come back in. */

/** Local service businesses that buy websites and marketing. */
export const SMB = [
  'dentists', 'lawyers', 'plumbers', 'HVAC contractors', 'roofing contractors',
  'electricians', 'restaurants', 'real estate agents', 'hair salons', 'gyms',
  'auto repair shops', 'accountants', 'chiropractors', 'landscaping companies',
  'pest control services', 'cleaning services', 'veterinarians', 'insurance agencies',
  'physical therapists', 'med spas', 'car dealerships', 'moving companies',
  'general contractors', 'daycare centers', 'photographers',
];

/** "Every local business": the SMB list plus shops, hospitality, health,
 * education and trades, so a town is covered beyond service businesses. */
export const ALL_LOCAL = [
  ...SMB,
  'cafes', 'bars', 'bakeries', 'pizza places', 'fast food restaurants', 'hotels',
  'guest houses', 'event venues', 'wedding planners', 'florists', 'caterers',
  'doctors', 'medical clinics', 'pharmacies', 'opticians', 'dermatologists',
  'psychologists', 'pediatricians', 'beauty salons', 'barber shops', 'nail salons',
  'spas', 'massage therapists', 'tattoo shops', 'yoga studios', 'dance schools',
  'car washes', 'tire shops', 'auto parts stores', 'driving schools',
  'painters', 'carpenters', 'locksmiths', 'flooring contractors', 'window installers',
  'solar installers', 'pool contractors', 'interior designers', 'architects',
  'furniture stores', 'home improvement stores', 'hardware stores', 'appliance repair',
  'computer repair', 'phone repair shops', 'electronics stores', 'clothing stores',
  'shoe stores', 'jewelry stores', 'gift shops', 'bookstores', 'toy stores',
  'pet stores', 'pet groomers', 'grocery stores', 'butcher shops', 'liquor stores',
  'travel agencies', 'marketing agencies', 'web design agencies', 'IT services',
  'printing services', 'notaries', 'financial advisors', 'mortgage brokers',
  'language schools', 'tutoring services', 'music schools', 'laundromats',
  'dry cleaners', 'tailors', 'storage facilities', 'funeral homes',
];

export const CATEGORY_PRESETS: Record<string, string[]> = {
  smb: SMB,
  all_local: [...new Set(ALL_LOCAL)],
};

/** Google Maps interface language for a country (ISO 3166-1 alpha-2). The
 * results come back in it -- addresses, categories, opening hours -- so a
 * report for a business there reads in the language its owner uses. */
const LANGUAGE: Record<string, string> = {
  us: 'en', gb: 'en', ie: 'en', ca: 'en', au: 'en', nz: 'en',
  bg: 'bg', de: 'de', at: 'de', ch: 'de', fr: 'fr', be: 'fr', es: 'es', mx: 'es',
  it: 'it', pt: 'pt', br: 'pt', nl: 'nl', pl: 'pl', ro: 'ro', gr: 'el', tr: 'tr',
  cz: 'cs', sk: 'sk', hu: 'hu', rs: 'sr', hr: 'hr', ru: 'ru', ua: 'uk',
};

export function languageFor(country: string | undefined): string {
  return LANGUAGE[(country ?? '').toLowerCase()] ?? 'en';
}
