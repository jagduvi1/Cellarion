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

// The device's time zone says where it is more reliably than its language: a
// Swede with an English (US) browser is still in Europe/Stockholm. Only zones
// that name one country are listed — America/* spans several currencies, so
// there the language's region decides.
const ZONE_REGION = {
  'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Arctic/Longyearbyen': 'NO',
  'Europe/Copenhagen': 'DK', 'Europe/London': 'GB', 'Europe/Zurich': 'CH',
  'Europe/Vaduz': 'LI', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE',
  'Europe/Busingen': 'DE', 'Europe/Madrid': 'ES', 'Atlantic/Canary': 'ES',
  'Africa/Ceuta': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT', 'Europe/Lisbon': 'PT',
  'Atlantic/Madeira': 'PT', 'Atlantic/Azores': 'PT', 'Europe/Dublin': 'IE',
  'Europe/Helsinki': 'FI', 'Europe/Mariehamn': 'FI', 'Europe/Athens': 'GR',
  'Europe/Luxembourg': 'LU', 'Europe/Tallinn': 'EE', 'Europe/Riga': 'LV',
  'Europe/Vilnius': 'LT', 'Europe/Bratislava': 'SK', 'Europe/Ljubljana': 'SI',
  'Europe/Malta': 'MT', 'Europe/Zagreb': 'HR', 'Asia/Nicosia': 'CY',
  'Europe/Nicosia': 'CY', 'Asia/Famagusta': 'CY', 'Europe/Sofia': 'BG',
  'Europe/Monaco': 'MC', 'Europe/Andorra': 'AD', 'Europe/San_Marino': 'SM',
  'Europe/Vatican': 'VA', 'Europe/Podgorica': 'ME', 'Asia/Tokyo': 'JP',
  'Asia/Hong_Kong': 'HK', 'Asia/Singapore': 'SG', 'Africa/Johannesburg': 'ZA',
  'Pacific/Auckland': 'NZ', 'Pacific/Chatham': 'NZ',
};

const currencyOf = (region) => {
  const code = REGION_CURRENCY[String(region || '').toUpperCase()];
  return code && CURRENCIES.includes(code) ? code : null;
};

// "sv-SE" → "SE"; a bare "sv" → its likely region via Intl.Locale.maximize()
// ("sv" → "SE", "de" → "DE"); unparseable or region-less → null.
function regionOfLanguage(tag) {
  try {
    const locale = new Intl.Locale(tag);
    return locale.region || locale.maximize().region || null;
  } catch {
    return null;
  }
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
 * The currency for a device: its time zone's country first, then the first of
 * its languages whose region has a supported currency. Both inputs default to
 * the device's own and can be passed for tests.
 * @returns {string|null} a supported ISO 4217 code, or null when unsure
 */
export function guessCurrency({ timeZone = deviceTimeZone(), languages = deviceLanguages() } = {}) {
  if (timeZone) {
    const zoneRegion = ZONE_REGION[timeZone] || (timeZone.startsWith('Australia/') ? 'AU' : null);
    const fromZone = currencyOf(zoneRegion);
    if (fromZone) return fromZone;
  }
  for (const tag of languages || []) {
    const fromLanguage = currencyOf(regionOfLanguage(tag));
    if (fromLanguage) return fromLanguage;
  }
  return null;
}
