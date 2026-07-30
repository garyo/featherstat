/**
 * Country display helpers. The query vocabulary returns ISO 3166-1 alpha-2
 * codes; the flag is pure arithmetic on them (regional indicator symbols), and
 * the English name comes from Intl — no shipped country table.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;

/** `US` → 🇺🇸; anything that is not two ASCII letters → undefined. */
export function flagEmoji(code: string): string | undefined {
  if (!/^[A-Za-z]{2}$/.test(code)) return undefined;
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    REGIONAL_INDICATOR_A + upper.charCodeAt(0) - 65,
    REGIONAL_INDICATOR_A + upper.charCodeAt(1) - 65,
  );
}

const displayNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return undefined;
  }
})();

/** `US` → `United States`; falls back to the code when Intl draws a blank. */
export function countryName(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return displayNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * US and Canadian subdivisions by the English name a geo database reports.
 * Unlike countries there is no Intl table to ask, and the two sources disagree:
 * DB-IP City Lite carries only `names.en` ("Massachusetts"), while the Matomo
 * importer writes ISO 3166-2 codes ("MA"). This is the one place that knows.
 */
const SUBDIVISION_CODES: Readonly<Record<string, string>> = {
  Alabama: 'AL',
  Alaska: 'AK',
  Arizona: 'AZ',
  Arkansas: 'AR',
  California: 'CA',
  Colorado: 'CO',
  Connecticut: 'CT',
  Delaware: 'DE',
  'District of Columbia': 'DC',
  Florida: 'FL',
  Georgia: 'GA',
  Hawaii: 'HI',
  Idaho: 'ID',
  Illinois: 'IL',
  Indiana: 'IN',
  Iowa: 'IA',
  Kansas: 'KS',
  Kentucky: 'KY',
  Louisiana: 'LA',
  Maine: 'ME',
  Maryland: 'MD',
  Massachusetts: 'MA',
  Michigan: 'MI',
  Minnesota: 'MN',
  Mississippi: 'MS',
  Missouri: 'MO',
  Montana: 'MT',
  Nebraska: 'NE',
  Nevada: 'NV',
  'New Hampshire': 'NH',
  'New Jersey': 'NJ',
  'New Mexico': 'NM',
  'New York': 'NY',
  'North Carolina': 'NC',
  'North Dakota': 'ND',
  Ohio: 'OH',
  Oklahoma: 'OK',
  Oregon: 'OR',
  Pennsylvania: 'PA',
  'Rhode Island': 'RI',
  'South Carolina': 'SC',
  'South Dakota': 'SD',
  Tennessee: 'TN',
  Texas: 'TX',
  Utah: 'UT',
  Vermont: 'VT',
  Virginia: 'VA',
  Washington: 'WA',
  'West Virginia': 'WV',
  Wisconsin: 'WI',
  Wyoming: 'WY',
  'Puerto Rico': 'PR',
  Guam: 'GU',
  'U.S. Virgin Islands': 'VI',
  Alberta: 'AB',
  'British Columbia': 'BC',
  Manitoba: 'MB',
  'New Brunswick': 'NB',
  'Newfoundland and Labrador': 'NL',
  'Northwest Territories': 'NT',
  'Nova Scotia': 'NS',
  Nunavut: 'NU',
  Ontario: 'ON',
  'Prince Edward Island': 'PE',
  Quebec: 'QC',
  Québec: 'QC',
  Saskatchewan: 'SK',
  Yukon: 'YT',
};

/**
 * `Massachusetts` → `MA`, `MA` → `MA`, anything unrecognised → undefined, so a
 * caller can fall back rather than print a word it did not mean to print.
 */
export function subdivisionCode(region: string): string | undefined {
  if (/^[A-Z]{2}$/.test(region)) return region;
  return SUBDIVISION_CODES[region];
}
