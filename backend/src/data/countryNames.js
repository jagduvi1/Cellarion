/**
 * Recognized country names — the mint gate for findOrCreateCountry.
 *
 * Why this exists (support ticket 2026-07-26): findOrCreateCountry minted a
 * Country document for ANY unmatched string, so a garbled label scan created
 * the country "Espalda" (a misread "España") on prod — re-opening the drift
 * the 2026-07-18 taxonomy cleanup closed. A new Country may now only be minted
 * when the (alias-resolved) name appears in this list.
 *
 * Contents: ISO 3166-1 English short names, plus the wine-world conventions
 * the taxonomy already uses (England over United Kingdom — see COUNTRY_ALIASES
 * in utils/normalize.js — plus Scotland/Wales/Northern Ireland, Kosovo,
 * Taiwan) and common alternate English forms (Czechia, Türkiye, Ivory Coast).
 * Matching is by normalizeString() on BOTH sides, so case, diacritics and
 * punctuation never matter ("Côte d'Ivoire" ≡ "cote divoire").
 *
 * NOT a list of wine countries — a full country list on purpose. The gate's
 * job is rejecting non-countries ("Espalda", "Back label", "Red"), not
 * editorializing about where wine may come from; an Indian or Thai wine must
 * import cleanly. Localized names ("Tyskland") belong in COUNTRY_ALIASES,
 * which resolves BEFORE this list is consulted — an unlisted foreign-language
 * spelling is rejected with a "use the English name" error rather than minted.
 */
const RECOGNIZED_COUNTRY_NAMES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola',
  'Antigua and Barbuda', 'Argentina', 'Armenia', 'Australia', 'Austria',
  'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus',
  'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia',
  'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burma', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon',
  'Canada', 'Cape Verde', 'Central African Republic', 'Chad', 'Chile',
  'China', 'Colombia', 'Comoros', 'Congo', 'Costa Rica', "Côte d'Ivoire",
  'Croatia', 'Cuba', 'Cyprus', 'Czech Republic', 'Czechia',
  'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'East Timor', 'Ecuador', 'Egypt', 'El Salvador',
  'England', 'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini',
  'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
  'Germany', 'Ghana', 'Greece', 'Greenland', 'Grenada', 'Guatemala',
  'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras', 'Hong Kong',
  'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland',
  'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan',
  'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait', 'Kyrgyzstan',
  'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya',
  'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau', 'Madagascar',
  'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands',
  'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco',
  'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia',
  'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua', 'Niger',
  'Nigeria', 'North Korea', 'North Macedonia', 'Northern Ireland', 'Norway',
  'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea',
  'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar',
  'Republic of the Congo', 'Romania', 'Russia', 'Russian Federation',
  'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Samoa', 'San Marino',
  'São Tomé and Príncipe', 'Saudi Arabia', 'Scotland', 'Senegal', 'Serbia',
  'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia',
  'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan',
  'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Swaziland', 'Sweden',
  'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand',
  'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia',
  'Turkey', 'Türkiye', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Uruguay',
  'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam', 'Wales',
  'Yemen', 'Zambia', 'Zimbabwe',
];

module.exports = { RECOGNIZED_COUNTRY_NAMES };
