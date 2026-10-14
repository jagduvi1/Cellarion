import { CURRENCIES } from '../config/currencies';

// A new account's currency, guessed once from the device at its first sign-in
// (AuthContext → POST /api/users/me/locale-defaults). Before this every account
// started on USD, and a European collector saw bottle values in dollars until
// they found Settings.
//
// Only currencies the app supports (config/currencies.js) are ever returned;
// anything else answers null and the account keeps the server's default.

const EURO_AREA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES',
  // Not members, but the euro is their currency.
  'AD', 'MC', 'SM', 'VA', 'ME', 'XK',
];

const REGION_CURRENCY = {
  US: 'USD', GB: 'GBP', SE: 'SEK', NO: 'NOK', DK: 'DKK', CH: 'CHF', LI: 'CHF',
  CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', HK: 'HKD', SG: 'SGD', ZA: 'ZAR',
  ...Object.fromEntries(EURO_AREA.map((r) => [r, 'EUR'])),
};

const zones = (region, list) => Object.fromEntries(list.map((z) => [z, region]));

// The device's time zone says where it is more reliably than its language: a
// Swede with an English (US) browser is still in Europe/Stockholm, a Canadian
// with one is in America/Toronto. Every IANA zone belongs to one country; the
// ones listed are those of the supported currencies' countries, plus European
// neighbours whose currency is NOT supported — those must stop the guess
// (a Pole with an en-GB browser is not a GBP collector).
const ZONE_REGION = {
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Arctic/Longyearbyen': 'NO',
  'Europe/Copenhagen': 'DK', 'Atlantic/Faroe': 'DK', 'Europe/London': 'GB',
  'Europe/Jersey': 'GB', 'Europe/Guernsey': 'GB', 'Europe/Isle_of_Man': 'GB',
  'Europe/Zurich': 'CH', 'Europe/Vaduz': 'LI', 'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE', 'Europe/Busingen': 'DE', 'Europe/Madrid': 'ES',
  'Atlantic/Canary': 'ES', 'Africa/Ceuta': 'ES', 'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT',
  'Europe/Lisbon': 'PT', 'Atlantic/Madeira': 'PT', 'Atlantic/Azores': 'PT',
  'Europe/Dublin': 'IE', 'Europe/Helsinki': 'FI', 'Europe/Mariehamn': 'FI',
  'Europe/Athens': 'GR', 'Europe/Luxembourg': 'LU', 'Europe/Tallinn': 'EE',
  'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT', 'Europe/Bratislava': 'SK',
  'Europe/Ljubljana': 'SI', 'Europe/Malta': 'MT', 'Europe/Zagreb': 'HR',
  'Asia/Nicosia': 'CY', 'Europe/Nicosia': 'CY', 'Asia/Famagusta': 'CY',
  'Europe/Sofia': 'BG', 'Europe/Monaco': 'MC', 'Europe/Andorra': 'AD',
  'Europe/San_Marino': 'SM', 'Europe/Vatican': 'VA', 'Europe/Podgorica': 'ME',
  'Asia/Tokyo': 'JP', 'Asia/Hong_Kong': 'HK', 'Asia/Singapore': 'SG',
  'Africa/Johannesburg': 'ZA', 'Pacific/Auckland': 'NZ', 'Pacific/Chatham': 'NZ',
  // Europe, currency not supported: the guess stops here.
  'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Budapest': 'HU',
  'Europe/Bucharest': 'RO', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA',
  'Europe/Istanbul': 'TR', 'Europe/Moscow': 'RU', 'Europe/Belgrade': 'RS',
  'Europe/Sarajevo': 'BA', 'Europe/Skopje': 'MK', 'Europe/Tirane': 'AL',
  'Europe/Chisinau': 'MD', 'Europe/Minsk': 'BY', 'Atlantic/Reykjavik': 'IS',
  'Europe/Gibraltar': 'GI',
  ...zones('US', [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'America/Anchorage', 'America/Juneau', 'America/Sitka',
    'America/Yakutat', 'America/Nome', 'America/Metlakatla', 'America/Adak',
    'America/Boise', 'America/Detroit', 'America/Menominee',
    'America/Indiana/Indianapolis', 'America/Indiana/Knox', 'America/Indiana/Marengo',
    'America/Indiana/Petersburg', 'America/Indiana/Tell_City', 'America/Indiana/Vevay',
    'America/Indiana/Vincennes', 'America/Indiana/Winamac',
    'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
    'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
    'Pacific/Honolulu',
  ]),
  ...zones('CA', [
    'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg',
    'America/Halifax', 'America/St_Johns', 'America/Regina', 'America/Moncton',
    'America/Glace_Bay', 'America/Goose_Bay', 'America/Swift_Current',
    'America/Whitehorse', 'America/Dawson', 'America/Dawson_Creek', 'America/Fort_Nelson',
    'America/Creston', 'America/Yellowknife', 'America/Inuvik', 'America/Cambridge_Bay',
    'America/Rankin_Inlet', 'America/Resolute', 'America/Iqaluit', 'America/Atikokan',
    'America/Blanc-Sablon', 'America/Montreal', 'America/Nipigon', 'America/Thunder_Bay',
    'America/Rainy_River', 'America/Pangnirtung',
  ]),
};

const currencyOf = (region) => {
  const code = REGION_CURRENCY[String(region || '').toUpperCase()];
  return code && CURRENCIES.includes(code) ? code : null;
};

// The region a tag names itself ("sv-SE" → "SE"), else null.
function explicitRegion(tag) {
  try { return new Intl.Locale(tag).region || null; } catch { return null; }
}

// A bare language's likely region via Intl.Locale.maximize() ("sv" → "SE").
function likelyRegion(tag) {
  try { return new Intl.Locale(tag).maximize().region || null; } catch { return null; }
}

function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
}

function deviceLanguages() {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

/**
 * The currency for a device, in this order:
 *  1. its time zone's country — authoritative when known, even when that
 *     country's currency is not supported (then null: keep the default);
 *  2. the first language tag that names a region ("en-GB");
 *  3. a bare language's likely region ("sv" → SE) — only where the zone is
 *     European or unknown: a bare "es" in Mexico is not a euro collector.
 * Both inputs default to the device's own and can be passed for tests.
 * @returns {string|null} a supported ISO 4217 code, or null when unsure
 */
export function guessCurrency({ timeZone = deviceTimeZone(), languages = deviceLanguages() } = {}) {
  const zoneRegion = timeZone
    ? (ZONE_REGION[timeZone] || (timeZone.startsWith('Australia/') ? 'AU' : null))
    : null;
  if (zoneRegion) return currencyOf(zoneRegion);

  const tags = Array.isArray(languages) ? languages : [];
  for (const tag of tags) {
    const fromTag = currencyOf(explicitRegion(tag));
    if (fromTag) return fromTag;
  }

  const zoneIsEuropeanOrUnknown = !timeZone || timeZone.startsWith('Europe/') || timeZone.startsWith('Etc/') || timeZone === 'UTC';
  if (zoneIsEuropeanOrUnknown) {
    for (const tag of tags) {
      if (explicitRegion(tag)) continue;
      const fromLanguage = currencyOf(likelyRegion(tag));
      if (fromLanguage) return fromLanguage;
    }
  }
  return null;
}
