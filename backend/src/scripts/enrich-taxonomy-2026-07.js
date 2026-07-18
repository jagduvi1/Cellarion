/**
 * enrich-taxonomy-2026-07.js
 *
 * Fills the empty enrichment fields found by the 2026-07-18 taxonomy audit
 * (304/307 grapes had no color/origin/description; 2/69 countries had a
 * description; 6/338 regions had any data).
 *
 *   Grapes    — color + origin for every known variety; description,
 *               characteristics and agingPotential for the most-used ~60.
 *   Countries — ISO code + one-paragraph description for every wine country.
 *   Regions   — description for the ~40 most-used regions.
 *
 * NON-DESTRUCTIVE: a field is only written when it is currently empty, so
 * admin-curated data is never overwritten. Safe to re-run any time.
 *
 * Usage:
 *   node src/scripts/enrich-taxonomy-2026-07.js           # dry run
 *   node src/scripts/enrich-taxonomy-2026-07.js --apply   # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { normalizeString } = require('../utils/normalize');

const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------------------
// GRAPES — [name]: { color, origin, desc?, chars?, aging? }
// color respects the schema enum (Red | White); gris/pink-skinned varieties
// follow the wine they make (Pinot Gris → White), matching common practice.
// ---------------------------------------------------------------------------
const G = {
  // ===== International reds =====
  'Cabernet Sauvignon': { color: 'Red', origin: 'France (Bordeaux)', desc: 'The world\'s most planted quality red grape, a natural Cabernet Franc × Sauvignon Blanc crossing from Bordeaux. Small, thick-skinned berries give deep colour, firm tannin and blackcurrant fruit with cedar and graphite notes.', chars: ['blackcurrant', 'cedar', 'firm tannin', 'full-bodied'], aging: 'Excellent — top examples age 20+ years' },
  'Merlot': { color: 'Red', origin: 'France (Bordeaux)', desc: 'Bordeaux\'s most planted grape and the backbone of the Right Bank. Softer and fleshier than Cabernet Sauvignon, with plum and black-cherry fruit and a round, supple texture.', chars: ['plum', 'black cherry', 'supple', 'medium-full body'], aging: 'Good — top Pomerol ages decades' },
  'Cabernet Franc': { color: 'Red', origin: 'France (Bordeaux / Loire)', desc: 'Parent of Cabernet Sauvignon and Merlot, at home in Bordeaux blends and varietal Loire reds (Chinon, Bourgueil). Aromatic, medium-bodied, with raspberry, violet and a signature leafy-graphite edge.', chars: ['raspberry', 'violet', 'leafy', 'medium body'], aging: 'Good — 10–20 years for top wines' },
  'Pinot Noir': { color: 'Red', origin: 'France (Burgundy)', desc: 'The great red grape of Burgundy and Champagne — thin-skinned, early-ripening and famously site-sensitive. At its best it delivers red cherry, rose and forest-floor perfume with silky tannins.', chars: ['red cherry', 'rose', 'forest floor', 'silky'], aging: 'Very good — grand cru Burgundy ages 20+ years' },
  'Syrah': { color: 'Red', origin: 'France (Northern Rhône)', desc: 'The single red grape of Hermitage and Côte-Rôtie, and as Shiraz the flagship of Australia. Black pepper, dark berries and olive in cool climates; richer, chocolatey fruit in warm ones.', chars: ['black pepper', 'blackberry', 'olive', 'full-bodied'], aging: 'Excellent — 15–30 years for top bottlings' },
  'Grenache': { color: 'Red', origin: 'Spain (Aragón)', desc: 'Garnacha in its native Spain, the engine of Châteauneuf-du-Pape and Priorat. Late-ripening and heat-loving, giving strawberry-kirsch fruit, garrigue spice and generous alcohol.', chars: ['strawberry', 'kirsch', 'garrigue', 'warm'], aging: 'Good — top cuvées 15+ years' },
  'Mourvèdre': { color: 'Red', origin: 'Spain (Valencia / Murcia)', desc: 'Monastrell in Spain, Mataro in Australia; the structural spine of Bandol. Needs serious heat, rewarding it with dark, meaty, wild-herb reds of imposing tannin that age superbly.', chars: ['dark fruit', 'meaty', 'wild herbs', 'tannic'], aging: 'Excellent — Bandol ages 20+ years' },
  'Malbec': { color: 'Red', origin: 'France (Cahors)', desc: 'Côt of Cahors reborn as Argentina\'s signature grape, above all in Mendoza\'s high-altitude vineyards. Deep violet colour, plush blackberry and plum fruit, floral lift and velvety tannin.', chars: ['blackberry', 'violet', 'plush', 'full-bodied'], aging: 'Good — 10–15 years for top wines' },
  'Petit Verdot': { color: 'Red', origin: 'France (Bordeaux)', desc: 'Bordeaux\'s late-ripening seasoning grape, added in small doses for colour, tannin and violet perfume. Varietal bottlings from warmer climates are inky and powerful.', chars: ['violet', 'inky', 'firm tannin'], aging: 'Very good in blends' },
  'Carignan': { color: 'Red', origin: 'Spain (Aragón)', desc: 'Mazuelo/Cariñena in Spain, once the workhorse of the Languedoc. Old bush vines yield concentrated, savoury reds with dark berry fruit, iron and a rustic grip.', chars: ['dark berries', 'savoury', 'rustic grip'], aging: 'Moderate — old-vine cuvées longer' },
  'Cinsault': { color: 'Red', origin: 'France (Languedoc)', desc: 'Heat-tolerant southern French grape prized for perfumed, light-bodied reds and serious rosé; a parent of Pinotage. Red berries, dried flowers and soft tannin.', chars: ['red berries', 'floral', 'light-bodied'], aging: 'Drink young to mid-term' },
  'Zinfandel': { color: 'Red', origin: 'Croatia (as Tribidrag / Crljenak)', desc: 'Genetically identical to Italy\'s Primitivo and Croatia\'s Tribidrag, but famous as California\'s heritage grape. Brambly blackberry and raspberry-jam fruit, black pepper and warming alcohol.', chars: ['bramble', 'jammy berries', 'peppery', 'high alcohol'], aging: 'Moderate — best within 10 years' },
  'Petite Sirah': { color: 'Red', origin: 'France (as Durif)', desc: 'Durif — a Syrah × Peloursin crossing — thriving in California. Inky-dark, dense wines with blueberry, dark chocolate and formidable tannin.', chars: ['blueberry', 'inky', 'massive tannin'], aging: 'Very good — tannin demands patience' },
  'Tannat': { color: 'Red', origin: 'France (Madiran)', desc: 'The famously tannic grape of Madiran and the national grape of Uruguay, where it grows notably softer and rounder.', chars: ['dark fruit', 'tannic', 'structured'], aging: 'Excellent' },
  'Alicante Bouschet': { color: 'Red', origin: 'France (Languedoc)', desc: 'A rare teinturier (red-fleshed) variety, now most serious in Portugal\'s Alentejo — deeply coloured, robust reds with dark plum and earth.', chars: ['dark plum', 'deep colour', 'robust'], aging: 'Good' },
  'Marselan': { color: 'Red', origin: 'France (Cabernet Sauvignon × Grenache)' },
  'Counoise': { color: 'Red', origin: 'France (Southern Rhône)' },
  'Muscardin': { color: 'Red', origin: 'France (Châteauneuf-du-Pape)' },
  'Vaccarèse': { color: 'Red', origin: 'France (Châteauneuf-du-Pape)' },
  'Terret Noir': { color: 'Red', origin: 'France (Languedoc)' },
  'Picpoul Noir': { color: 'Red', origin: 'France (Southern Rhône)' },
  'Picardan': { color: 'White', origin: 'France (Châteauneuf-du-Pape)' },
  'Grenache Gris': { color: 'White', origin: 'Spain / France (Roussillon)' },
  'Grolleau': { color: 'Red', origin: 'France (Loire Valley)' },
  'Pinot Meunier': { color: 'Red', origin: 'France (Champagne)', desc: 'Champagne\'s quietly essential third grape — a Pinot Noir mutation that buds late and ripens early, bringing supple orchard fruit and roundness to the blend; increasingly bottled on its own by growers.', chars: ['orchard fruit', 'supple', 'round'], aging: 'Very good in Champagne blends' },
  'Gamay': { color: 'Red', origin: 'France (Beaujolais)', desc: 'The grape of Beaujolais, where granite crus like Morgon and Moulin-à-Vent turn its bright cherry fruit and crunchy acidity into wines of real depth.', chars: ['cherry', 'crunchy acidity', 'light-medium body'], aging: 'Cru Beaujolais ages 10+ years' },
  'Trousseau': { color: 'Red', origin: 'France (Jura)' },
  'Poulsard': { color: 'Red', origin: 'France (Jura)' },
  'Manseng Noir': { color: 'Red', origin: 'France (South West)' },
  'Charbono': { color: 'Red', origin: 'France (Savoie, as Douce Noir)' },

  // ===== International whites =====
  'Chardonnay': { color: 'White', origin: 'France (Burgundy)', desc: 'The world\'s most versatile white grape — from steely Chablis to opulent barrel-fermented Meursault and the backbone of blanc-de-blancs Champagne. Flavours range from citrus and green apple to peach, hazelnut and butter.', chars: ['citrus', 'stone fruit', 'hazelnut', 'versatile'], aging: 'Very good — grand cru Burgundy 15+ years' },
  'Sauvignon Blanc': { color: 'White', origin: 'France (Loire Valley)', desc: 'Pungently aromatic white of Sancerre and Bordeaux, redefined by Marlborough\'s gooseberry-and-passionfruit style. Always high in acidity, from flinty and citrussy to tropical.', chars: ['gooseberry', 'citrus', 'herbaceous', 'high acidity'], aging: 'Mostly drink young; top Loire ages' },
  'Riesling': { color: 'White', origin: 'Germany (Rhine)', desc: 'Germany\'s great white grape and one of the world\'s finest — piercingly aromatic, high-acid, and transparent to site, spanning bone-dry to nobly sweet. Lime, green apple, white flowers and a petrol note with age.', chars: ['lime', 'white flowers', 'petrol (aged)', 'racy acidity'], aging: 'Exceptional — decades even for Kabinett' },
  'Chenin Blanc': { color: 'White', origin: 'France (Loire Valley)', desc: 'The chameleon of the Loire (Vouvray, Savennières) and South Africa\'s most planted grape. Quince, apple and honey with electric acidity in every style from sparkling to lusciously sweet.', chars: ['quince', 'honey', 'high acidity', 'all styles'], aging: 'Exceptional in demi-sec/sweet styles' },
  'Pinot Gris': { color: 'White', origin: 'France (Alsace)', desc: 'Pink-skinned Pinot mutation: rich, smoky and spicy in Alsace, light and crisp as Pinot Grigio in northern Italy.', chars: ['pear', 'smoke', 'spice', 'textural'], aging: 'Moderate' },
  'Pinot Blanc': { color: 'White', origin: 'France (Alsace)', desc: 'Weissburgunder in German-speaking regions — a gentle, appley, cream-textured white for early drinking, at its most serious in Alsace, Baden and Alto Adige.', chars: ['apple', 'creamy', 'gentle'], aging: 'Drink young to mid-term' },
  'Viognier': { color: 'White', origin: 'France (Northern Rhône)', desc: 'The apricot-and-honeysuckle grape of Condrieu, nearly extinct in the 1960s and now planted worldwide. Full-bodied, low-acid, headily perfumed.', chars: ['apricot', 'honeysuckle', 'full-bodied', 'low acidity'], aging: 'Drink young' },
  'Gewürztraminer': { color: 'White', origin: 'Italy (Alto Adige / Tramin)', desc: 'The most exuberantly aromatic of whites — lychee, rose petal and baking spice, at its greatest in Alsace grand cru and vendange tardive styles.', chars: ['lychee', 'rose', 'spice', 'opulent'], aging: 'Moderate; VT/SGN longer' },
  'Sémillon': { color: 'White', origin: 'France (Bordeaux)', desc: 'The great grape of Sauternes (with botrytis) and of Hunter Valley\'s ageworthy dry whites. Lanolin, lemon and beeswax, gaining toast and honey with age.', chars: ['lemon', 'lanolin', 'waxy', 'ages to honey/toast'], aging: 'Exceptional — Sauternes and Hunter Semillon age decades' },
  'Muscadelle': { color: 'White', origin: 'France (Bordeaux)', desc: 'The third white grape of Bordeaux and Bergerac, adding grapey perfume to Sauternes blends; also Rutherglen\'s Topaque in Australia.', chars: ['grapey', 'floral'], aging: 'In sweet blends, very good' },
  'Marsanne': { color: 'White', origin: 'France (Northern Rhône)', desc: 'The weightier half of the Hermitage Blanc partnership — honeysuckle, pear and almond with a rich, waxy texture.', chars: ['honeysuckle', 'almond', 'waxy'], aging: 'Good — closes then re-opens with age' },
  'Roussanne': { color: 'White', origin: 'France (Northern Rhône)', desc: 'Marsanne\'s aromatic partner in the Rhône — herbal tea, pear and apricot with nervier acidity, prized in white Châteauneuf and Savoie\'s Chignin-Bergeron.', chars: ['herbal tea', 'apricot', 'fresh'], aging: 'Good' },
  'Grenache Blanc': { color: 'White', origin: 'Spain (as Garnacha Blanca)', desc: 'White mutation of Grenache, key to white Châteauneuf-du-Pape and Rioja blanco blends — green apple, fennel and soft, mouth-filling body.', chars: ['green apple', 'fennel', 'soft'], aging: 'Moderate' },
  'Clairette': { color: 'White', origin: 'France (Southern Rhône)', desc: 'Ancient southern-French white bringing freshness and white-flower perfume to Rhône blends and Clairette de Die sparklers.', chars: ['white flowers', 'fresh'], aging: 'Drink young' },
  'Bourboulenc': { color: 'White', origin: 'France (Southern Rhône)' },
  'Ugni Blanc': { color: 'White', origin: 'Italy (as Trebbiano Toscano)' },
  'Colombard': { color: 'White', origin: 'France (Charente)' },
  'Folle Blanche': { color: 'White', origin: 'France (Loire / Gascony)' },
  'Baco Blanc': { color: 'White', origin: 'France (Armagnac hybrid)' },
  'Aligoté': { color: 'White', origin: 'France (Burgundy)', desc: 'Burgundy\'s "other" white — brisk, lemony and stony, traditionally the base of Kir and increasingly taken seriously from old vines in Bouzeron.', chars: ['lemon', 'stony', 'brisk'], aging: 'Drink young to mid-term' },
  'Melon de Bourgogne': { color: 'White', origin: 'France (Burgundy → Muscadet)' },
  'Savagnin': { color: 'White', origin: 'France (Jura)', desc: 'Jura\'s great white, the grape of Vin Jaune — under a flor-like veil it develops walnut, curry-spice and bracing salinity; ouillé (topped-up) styles are pure and alpine.', chars: ['walnut', 'saline', 'intense'], aging: 'Exceptional — Vin Jaune ages 50+ years' },
  'Altesse': { color: 'White', origin: 'France (Savoie)' },
  'Molette': { color: 'White', origin: 'France (Savoie / Seyssel)' },
  'Tressallier': { color: 'White', origin: 'France (Saint-Pourçain)' },
  'Gros Manseng': { color: 'White', origin: 'France (Jurançon)' },
  'Petit Manseng': { color: 'White', origin: 'France (Jurançon)' },
  'Arrufiac': { color: 'White', origin: 'France (Pacherenc du Vic-Bilh)' },
  'Courbu': { color: 'White', origin: 'France (South West)' },
  'Chasselas': { color: 'White', origin: 'Switzerland (Lake Geneva)' },
  'Petite Arvine': { color: 'White', origin: 'Switzerland (Valais)' },

  // ===== Italy =====
  'Sangiovese': { color: 'Red', origin: 'Italy (Tuscany)', desc: 'Italy\'s most planted grape and the soul of Chianti, Brunello di Montalcino and Vino Nobile. Sour cherry, dried herbs and earth on a frame of vibrant acidity and firm, dusty tannin.', chars: ['sour cherry', 'dried herbs', 'high acidity', 'dusty tannin'], aging: 'Excellent — Brunello ages 20+ years' },
  'Nebbiolo': { color: 'Red', origin: 'Italy (Piedmont)', desc: 'The grape of Barolo and Barbaresco — pale in colour yet ferociously structured, with tar, rose, dried cherry and liquorice that need years to unwind.', chars: ['tar', 'rose', 'high acid + tannin', 'ethereal'], aging: 'Exceptional — 20–40 years for top crus' },
  'Barbera': { color: 'Red', origin: 'Italy (Piedmont)', desc: 'Piedmont\'s everyday hero: deep colour, juicy black-cherry fruit, low tannin and mouth-watering acidity, from simple trattoria wine to serious barrique-aged Barbera d\'Asti/Alba.', chars: ['black cherry', 'juicy', 'high acidity', 'low tannin'], aging: 'Moderate — best examples 10 years' },
  'Dolcetto': { color: 'Red', origin: 'Italy (Piedmont)', desc: 'Piedmont\'s "little sweet one" — soft, dark-fruited, gently bitter-almond reds for the table while Nebbiolo matures.', chars: ['black fruit', 'almond', 'soft'], aging: 'Drink young' },
  'Corvina': { color: 'Red', origin: 'Italy (Veneto)', desc: 'The lead grape of Valpolicella and Amarone — sour cherry and herbs, with a genius for the appassimento (grape-drying) process.', chars: ['sour cherry', 'herbs', 'appassimento'], aging: 'Amarone ages 20+ years' },
  'Corvinone': { color: 'Red', origin: 'Italy (Veneto)', desc: 'Once thought a Corvina clone, now known to be distinct — large berries that dry beautifully, adding spice and structure to Amarone blends.', chars: ['dark cherry', 'spice'], aging: 'Very good in Amarone' },
  'Rondinella': { color: 'Red', origin: 'Italy (Veneto)', desc: 'Reliable, hardy supporting grape of the Valpolicella blend, contributing colour and herbal red fruit.', chars: ['red fruit', 'herbal'], aging: 'In blends' },
  'Molinara': { color: 'Red', origin: 'Italy (Veneto)', desc: 'Traditional acid-lifting minor partner in Valpolicella blends, pale and delicately sour.', chars: ['pale', 'sour red fruit'], aging: 'In blends' },
  'Oseleta': { color: 'Red', origin: 'Italy (Veneto)' },
  'Montepulciano': { color: 'Red', origin: 'Italy (Abruzzo)', desc: 'The generous grape of Montepulciano d\'Abruzzo (no relation to the Tuscan town) — deep colour, ripe black plum, soft tannin and easy richness.', chars: ['black plum', 'deep colour', 'soft'], aging: 'Moderate — Riserva longer' },
  'Nero d\'Avola': { color: 'Red', origin: 'Italy (Sicily)', desc: 'Sicily\'s flagship red — sun-soaked black cherry and plum with Mediterranean herbs, from juicy everyday wines to structured Noto and Vittoria bottlings.', chars: ['black cherry', 'mediterranean herbs', 'ripe'], aging: 'Moderate' },
  'Frappato': { color: 'Red', origin: 'Italy (Sicily)', desc: 'Vittoria\'s perfumed, pale red — strawberry and violet, light on its feet; partner of Nero d\'Avola in Cerasuolo di Vittoria.', chars: ['strawberry', 'violet', 'light'], aging: 'Drink young' },
  'Nerello Mascalese': { color: 'Red', origin: 'Italy (Sicily / Etna)', desc: 'Etna\'s volcanic star, often likened to Nebbiolo and Pinot Noir — pale, taut, smoky red-cherry wines that map their lava-terrace crus.', chars: ['red cherry', 'smoky', 'mineral', 'taut'], aging: 'Very good' },
  'Nerello Cappuccio': { color: 'Red', origin: 'Italy (Sicily / Etna)' },
  'Perricone': { color: 'Red', origin: 'Italy (Sicily)' },
  'Aglianico': { color: 'Red', origin: 'Italy (Campania / Basilicata)', desc: 'The "Barolo of the South" — Taurasi\'s dark, savoury, tannic grape with black fruit, smoke and volcanic grip that rewards long cellaring.', chars: ['black fruit', 'smoke', 'tannic', 'savoury'], aging: 'Excellent — 15–25 years' },
  'Negroamaro': { color: 'Red', origin: 'Italy (Puglia)', desc: 'Salento\'s "black-bitter" grape — plummy, spicy reds and serious rosato, the heart of Salice Salentino.', chars: ['plum', 'spice', 'gently bitter'], aging: 'Moderate' },
  'Nero di Troia': { color: 'Red', origin: 'Italy (Puglia)' },
  'Sagrantino': { color: 'Red', origin: 'Italy (Umbria / Montefalco)' },
  'Ciliegiolo': { color: 'Red', origin: 'Italy (Tuscany)' },
  'Canaiolo': { color: 'Red', origin: 'Italy (Tuscany)' },
  'Colorino': { color: 'Red', origin: 'Italy (Tuscany)' },
  'Lagrein': { color: 'Red', origin: 'Italy (Alto Adige)' },
  'Schiava': { color: 'Red', origin: 'Italy (Alto Adige, as Vernatsch)' },
  'Teroldego': { color: 'Red', origin: 'Italy (Trentino)' },
  'Marzemino': { color: 'Red', origin: 'Italy (Trentino)' },
  'Lambrusco': { color: 'Red', origin: 'Italy (Emilia-Romagna)' },
  'Croatina': { color: 'Red', origin: 'Italy (Oltrepò Pavese / Colli Piacentini)' },
  'Ruchè': { color: 'Red', origin: 'Italy (Piedmont / Castagnole Monferrato)' },
  'Freisa': { color: 'Red', origin: 'Italy (Piedmont)' },
  'Gamba di Pernice': { color: 'Red', origin: 'Italy (Piedmont / Calosso)' },
  'Pelaverga Piccolo': { color: 'Red', origin: 'Italy (Piedmont / Verduno)' },
  'Groppello': { color: 'Red', origin: 'Italy (Lombardy / Valtènesi)' },
  'Gaglioppo': { color: 'Red', origin: 'Italy (Calabria / Cirò)' },
  'Piedirosso': { color: 'Red', origin: 'Italy (Campania)' },
  'Sciascinoso': { color: 'Red', origin: 'Italy (Campania)' },
  'Cesanese': { color: 'Red', origin: 'Italy (Lazio)' },
  'Cesanese Comune': { color: 'Red', origin: 'Italy (Lazio)' },
  'Cesanese d\'Affile': { color: 'Red', origin: 'Italy (Lazio / Affile)' },
  'Nero Buono': { color: 'Red', origin: 'Italy (Lazio / Cori)' },
  'Aleatico': { color: 'Red', origin: 'Italy (Lazio / Elba)' },
  'Malvasia Nera': { color: 'Red', origin: 'Italy (Puglia)' },
  'Refosco dal Peduncolo Rosso': { color: 'Red', origin: 'Italy (Friuli)' },
  'Schioppettino': { color: 'Red', origin: 'Italy (Friuli)' },
  'Glera': { color: 'White', origin: 'Italy (Veneto / Friuli)', desc: 'The Prosecco grape — fresh pear, white blossom and gentle fizz; the steep Valdobbiadene hills yield its most refined examples.', chars: ['pear', 'blossom', 'fresh', 'sparkling'], aging: 'Drink young' },
  'Garganega': { color: 'White', origin: 'Italy (Veneto / Soave)' },
  'Turbiana': { color: 'White', origin: 'Italy (Lombardy / Lugana)' },
  'Trebbiano di Soave': { color: 'White', origin: 'Italy (Veneto)' },
  'Trebbiano Toscano': { color: 'White', origin: 'Italy (Tuscany)' },
  'Trebbiano': { color: 'White', origin: 'Italy' },
  'Procanico': { color: 'White', origin: 'Italy (Umbria)' },
  'Vermentino': { color: 'White', origin: 'Italy (Liguria / Sardinia)', desc: 'The Mediterranean coast\'s salty, herb-tinged white — citrus and green almond, at its ripest in Sardinia (Vermentino di Gallura DOCG) and as Rolle in Provence.', chars: ['citrus', 'green almond', 'saline'], aging: 'Drink young to mid-term' },
  'Bosco': { color: 'White', origin: 'Italy (Liguria / Cinque Terre)' },
  'Albarola': { color: 'White', origin: 'Italy (Liguria)' },
  'Fiano': { color: 'White', origin: 'Italy (Campania)' },
  'Falanghina': { color: 'White', origin: 'Italy (Campania)' },
  'Grillo': { color: 'White', origin: 'Italy (Sicily)' },
  'Insolia': { color: 'White', origin: 'Italy (Sicily)' },
  'Catarratto': { color: 'White', origin: 'Italy (Sicily)' },
  'Carricante': { color: 'White', origin: 'Italy (Sicily / Etna)' },
  'Albanello': { color: 'White', origin: 'Italy (Sicily)' },
  'Zibibbo': { color: 'White', origin: 'Italy (Sicily / Pantelleria)' },
  'Verdicchio': { color: 'White', origin: 'Italy (Marche)' },
  'Grechetto': { color: 'White', origin: 'Italy (Umbria)' },
  'Vernaccia di San Gimignano': { color: 'White', origin: 'Italy (Tuscany)' },
  'Malvasia del Chianti': { color: 'White', origin: 'Italy (Tuscany)' },
  'Malvasia del Lazio': { color: 'White', origin: 'Italy (Lazio)' },
  'Malvasia Istriana': { color: 'White', origin: 'Italy (Friuli / Istria)' },
  'Friulano': { color: 'White', origin: 'Italy (Friuli)' },
  'Ribolla Gialla': { color: 'White', origin: 'Italy (Friuli)' },
  'Vitovska': { color: 'White', origin: 'Italy (Friuli / Carso)' },
  'Picolit': { color: 'White', origin: 'Italy (Friuli)' },
  'Lacrima': { color: 'Red', origin: 'Italy (Marche / Morro d\'Alba)' },
  'Picpoul Blanc': { color: 'White', origin: 'France (Languedoc / Picpoul de Pinet)' },
  'Malvasia Fina': { color: 'White', origin: 'Portugal (Douro / Dão)' },
  'Moscato': { color: 'White', origin: 'Italy' },
  'Durella': { color: 'White', origin: 'Italy (Veneto / Lessini)' },
  'Timorasso': { color: 'White', origin: 'Italy (Piedmont / Colli Tortonesi)' },
  'Arneis': { color: 'White', origin: 'Italy (Piedmont / Roero)' },
  'Asprinio di Aversa': { color: 'White', origin: 'Italy (Campania)' },
  'Rossese Bianco': { color: 'White', origin: 'Italy (Piedmont)' },
  'Nielluccio': { color: 'Red', origin: 'France (Corsica; Sangiovese)' },
  'Sciacarello': { color: 'Red', origin: 'France (Corsica)' },

  // ===== Spain =====
  'Tempranillo': { color: 'Red', origin: 'Spain (Rioja / Ribera del Duero)', desc: 'Spain\'s noblest red grape — strawberry and tobacco in youth, leather and dried fig after long oak aging; Tinta Roriz/Aragonez across the border in Portugal.', chars: ['strawberry', 'tobacco', 'leather (aged)', 'medium-full'], aging: 'Excellent — Gran Reserva ages decades' },
  'Graciano': { color: 'Red', origin: 'Spain (Rioja)', desc: 'Rioja\'s aromatic seasoning grape — low yields of dark, floral, spicy fruit with the acidity Tempranillo lacks; rare varietal bottlings are prized.', chars: ['dark fruit', 'floral', 'fresh acidity'], aging: 'Very good' },
  'Macabeo': { color: 'White', origin: 'Spain (Rioja / Catalonia)', desc: 'Viura in Rioja, Macabeu in Roussillon — the backbone of white Rioja and of Cava\'s classic three-grape blend; gently floral, appley and honeyed with age.', chars: ['apple', 'floral', 'honeyed with age'], aging: 'Traditional white Rioja ages remarkably' },
  'Xarel-lo': { color: 'White', origin: 'Spain (Penedès)', desc: 'The structural heart of Cava — earthy, saline and vigorous, and increasingly a serious still white in Penedès.', chars: ['saline', 'earthy', 'structured'], aging: 'Good — carries long-aged Cava' },
  'Parellada': { color: 'White', origin: 'Spain (Catalonia)' },
  'Verdejo': { color: 'White', origin: 'Spain (Rueda)' },
  'Godello': { color: 'White', origin: 'Spain (Valdeorras / Galicia)' },
  'Albariño': { color: 'White', origin: 'Spain (Rías Baixas)' },
  'Airén': { color: 'White', origin: 'Spain (La Mancha)' },
  'Albillo': { color: 'White', origin: 'Spain (Castilla)' },
  'Albillo Mayor': { color: 'White', origin: 'Spain (Ribera del Duero)' },
  'Palomino': { color: 'White', origin: 'Spain (Jerez)' },
  'Pedro Ximénez': { color: 'White', origin: 'Spain (Montilla-Moriles / Jerez)' },
  'Malvasía': { color: 'White', origin: 'Mediterranean (Malvasia family)' },
  'Muscat': { color: 'White', origin: 'Mediterranean (Muscat family)' },
  'Muscat of Alexandria': { color: 'White', origin: 'Greece / Eastern Mediterranean' },
  'Muscat Blanc à Petits Grains': { color: 'White', origin: 'Greece (ancient Mediterranean)', desc: 'The oldest and finest member of the Muscat family — intensely grapey, floral and fine-grained, behind Moscato d\'Asti, Muscat de Beaumes-de-Venise and Rutherglen Muscat alike.', chars: ['grapey', 'orange blossom', 'fine'], aging: 'Fortified styles age superbly' },
  'Muskat Ottonel': { color: 'White', origin: 'France (Loire, 1852 crossing)' },
  'Black Muscat': { color: 'Red', origin: 'England (Muscat Hamburg crossing)' },
  'Moscatel de Setúbal': { color: 'White', origin: 'Portugal (Setúbal; Muscat of Alexandria)' },
  'Moscatel Roxo': { color: 'White', origin: 'Portugal (Setúbal; pink-skinned Muscat)' },
  'Mencía': { color: 'Red', origin: 'Spain (Bierzo / Ribeira Sacra)', desc: 'The aromatic red of Spain\'s Atlantic northwest — crunchy red and black fruit, violets and slate, from old vines on heroic slopes.', chars: ['crunchy fruit', 'violets', 'slate'], aging: 'Good' },
  'Bobal': { color: 'Red', origin: 'Spain (Utiel-Requena)' },
  'Caíño Tinto': { color: 'Red', origin: 'Spain (Galicia)' },
  'Pais': { color: 'Red', origin: 'Chile (as País; Listán Prieto)' },
  'Criollas': { color: 'Red', origin: 'South America (Criolla family)' },
  'Torrontés': { color: 'White', origin: 'Argentina (Salta / Cafayate)' },
  'Vigiriega': { color: 'White', origin: 'Spain (Granada)' },
  'Alarije': { color: 'White', origin: 'Spain (Extremadura)' },
  'Alicante': { color: 'Red', origin: 'Spain / Italy (ambiguous local name)' },

  // ===== Portugal =====
  'Touriga Nacional': { color: 'Red', origin: 'Portugal (Dão / Douro)', desc: 'Portugal\'s greatest red grape — the perfumed, structured core of vintage Port and of the Douro\'s finest dry reds. Violets, bergamot, dark berries and firm, ripe tannin.', chars: ['violets', 'bergamot', 'dark berries', 'structured'], aging: 'Exceptional — vintage Port ages half a century' },
  'Touriga Franca': { color: 'Red', origin: 'Portugal (Douro)', desc: 'The Douro\'s most planted Port grape — softer and more floral than Touriga Nacional, knitting blends together with supple red-berry fruit.', chars: ['floral', 'red berries', 'supple'], aging: 'Excellent in Port' },
  'Tinta Roriz': { color: 'Red', origin: 'Spain (as Tempranillo)', desc: 'The Douro and Dão name for Tempranillo — earlier-drinking spice and red fruit in Port blends and increasingly fine dry reds.', chars: ['red fruit', 'spice'], aging: 'Very good' },
  'Tinta Barroca': { color: 'Red', origin: 'Portugal (Douro)', desc: 'Early-ripening Port workhorse, planted on cooler aspects — rustic dark fruit and generous sugar for the blend.', chars: ['dark fruit', 'rustic'], aging: 'In Port blends' },
  'Tinto Cão': { color: 'Red', origin: 'Portugal (Douro)', desc: 'Ancient, low-yielding Port variety saved from near-extinction — fine, spicy, slow-aging backbone in top blends.', chars: ['spicy', 'fine', 'slow-aging'], aging: 'Excellent' },
  'Trincadeira': { color: 'Red', origin: 'Portugal (Alentejo)' },
  'Castelão': { color: 'Red', origin: 'Portugal (Setúbal / Palmela)' },
  'Baga': { color: 'Red', origin: 'Portugal (Bairrada)' },
  'Alfrocheiro': { color: 'Red', origin: 'Portugal (Dão)' },
  'Rufete': { color: 'Red', origin: 'Portugal (Beira / Douro)' },
  'Camarate': { color: 'Red', origin: 'Portugal (Lisboa)' },
  'Tinta Carvalha': { color: 'Red', origin: 'Portugal (Douro)' },
  'Arinto': { color: 'White', origin: 'Portugal (Bucelas)', desc: 'Portugal\'s acid-keeper — lemony, mineral and stubbornly fresh even in the hot Alentejo; the grape of Bucelas and a key Vinho Verde component.', chars: ['lemon', 'mineral', 'high acidity'], aging: 'Good' },
  'Arinto dos Açores': { color: 'White', origin: 'Portugal (Azores / Pico)' },
  'Antão Vaz': { color: 'White', origin: 'Portugal (Alentejo)' },
  'Roupeiro': { color: 'White', origin: 'Portugal (Alentejo, aka Síria)' },
  'Fernão Pires': { color: 'White', origin: 'Portugal (Tejo / Bairrada)' },
  'Bical': { color: 'White', origin: 'Portugal (Bairrada)' },
  'Cerceal': { color: 'White', origin: 'Portugal (Dão / Bairrada)' },
  'Rabigato': { color: 'White', origin: 'Portugal (Douro)' },
  'Viosinho': { color: 'White', origin: 'Portugal (Douro)' },
  'Verdelho': { color: 'White', origin: 'Portugal (Madeira)' },
  'Loureiro': { color: 'White', origin: 'Portugal (Vinho Verde)' },
  'Trajadura': { color: 'White', origin: 'Portugal (Vinho Verde)' },
  'Avesso': { color: 'White', origin: 'Portugal (Vinho Verde)' },
  'Azal': { color: 'White', origin: 'Portugal (Vinho Verde)' },
  'Codega do Larinho': { color: 'White', origin: 'Portugal (Douro)' },
  'Tanageira': { color: 'Red', origin: 'Portugal (Dão, rare local variety)' },

  // ===== Germany / Austria / Alpine =====
  'Grüner Veltliner': { color: 'White', origin: 'Austria (Niederösterreich)', desc: 'Austria\'s signature white — white pepper, lentil and green apple over a stony core, from chugging Federspiel to profound Smaragd that rivals white Burgundy.', chars: ['white pepper', 'green apple', 'stony'], aging: 'Very good — Smaragd 15+ years' },
  'Silvaner': { color: 'White', origin: 'Austria (natural crossing)', desc: 'Understated, earthy-fresh white at its best on Franken\'s limestone — subtle herbs, pear and a saline finish.', chars: ['herbal', 'pear', 'saline'], aging: 'Moderate' },
  'Müller-Thurgau': { color: 'White', origin: 'Switzerland (1882 Riesling × Madeleine Royale)' },
  'Scheurebe': { color: 'White', origin: 'Germany (Pfalz crossing)' },
  'Rieslaner': { color: 'White', origin: 'Germany (Franken crossing)' },
  'Kerner': { color: 'White', origin: 'Germany (Württemberg crossing)' },
  'Bacchus': { color: 'White', origin: 'Germany (crossing)' },
  'Welschriesling': { color: 'White', origin: 'Central Europe (unrelated to Riesling)' },
  'Roter Riesling': { color: 'White', origin: 'Germany (pink-skinned Riesling mutation)' },
  'Weißburgunder': { color: 'White', origin: 'France (as Pinot Blanc)' },
  'Zweigelt': { color: 'Red', origin: 'Austria (1922 St. Laurent × Blaufränkisch)', desc: 'Austria\'s most planted red — juicy sour-cherry fruit, soft tannin and a peppery lift, from carafe wine to structured Burgenland bottlings.', chars: ['sour cherry', 'juicy', 'peppery'], aging: 'Moderate' },
  'Blaufränkisch': { color: 'Red', origin: 'Austria (Burgenland)', desc: 'Central Europe\'s great red (Lemberger in Germany, Kékfrankos in Hungary) — dark sour cherry, pepper and iron with vivid acidity and ageworthy structure.', chars: ['dark cherry', 'pepper', 'iron', 'fresh'], aging: 'Very good — 10–20 years' },
  'St. Laurent': { color: 'Red', origin: 'Austria' },
  'Blauer Portugieser': { color: 'Red', origin: 'Austria / Central Europe' },
  'Dornfelder': { color: 'Red', origin: 'Germany (1955 crossing)' },
  'Domina': { color: 'Red', origin: 'Germany (Portugieser × Pinot Noir)' },
  'Regent': { color: 'Red', origin: 'Germany (fungus-resistant hybrid)' },
  'Neuburger': { color: 'White', origin: 'Austria (Wachau)' },
  'Garanoir': { color: 'Red', origin: 'Switzerland (Gamay crossing)' },
  'Humagne Rouge': { color: 'Red', origin: 'Switzerland (Valais)' },
  'Cornalin': { color: 'Red', origin: 'Switzerland (Valais)' },
  // PIWI (fungus-resistant) varieties common in Nordic/Belgian vineyards
  'Solaris': { color: 'White', origin: 'Germany (1975 PIWI crossing)', desc: 'Early-ripening, fungus-resistant crossing that has become the workhorse white of Scandinavian and other cool-climate vineyards — ripe pear, elderflower and tropical hints with lively acidity.', chars: ['pear', 'elderflower', 'cool-climate'], aging: 'Drink young' },
  'Johanniter': { color: 'White', origin: 'Germany (Riesling-based PIWI)' },
  'Muscaris': { color: 'White', origin: 'Germany (Solaris × Muscat PIWI)' },
  'Cabernet Blanc': { color: 'White', origin: 'Germany (Cabernet Sauvignon PIWI)' },
  'Riesling x Sylvaner': { color: 'White', origin: 'Switzerland (as Müller-Thurgau)' },

  // ===== Hungary / Balkans / Eastern Europe =====
  'Furmint': { color: 'White', origin: 'Hungary (Tokaj)', desc: 'Tokaj\'s great grape — fierce acidity and orchard fruit that carry both the world\'s most storied botrytis wine (Aszú) and increasingly brilliant dry whites.', chars: ['orchard fruit', 'botrytis-prone', 'searing acidity'], aging: 'Exceptional — Aszú ages a century' },
  'Hárslevelű': { color: 'White', origin: 'Hungary (Tokaj)' },
  'Sárgamuskotály': { color: 'White', origin: 'Hungary (as Muscat Blanc)' },
  'Plavac Mali': { color: 'Red', origin: 'Croatia (Dalmatia)' },
  'Babić': { color: 'Red', origin: 'Croatia (Dalmatia)' },
  'Plavina': { color: 'Red', origin: 'Croatia (Dalmatia)' },
  'Lasin': { color: 'Red', origin: 'Croatia (Dalmatia, aka Lasina)' },
  'Teran': { color: 'Red', origin: 'Croatia / Slovenia (Istria)' },
  'Prokupac': { color: 'Red', origin: 'Serbia' },
  'Mavrud': { color: 'Red', origin: 'Bulgaria (Thrace)' },
  'Saperavi': { color: 'Red', origin: 'Georgia (Kakheti)', desc: 'Georgia\'s ancient teinturier — inky, brambly, high-acid reds made for qvevri aging and long cellaring.', chars: ['inky', 'bramble', 'high acidity'], aging: 'Excellent' },
  'Rkatsiteli': { color: 'White', origin: 'Georgia (Kakheti)' },
  'Mtsvane': { color: 'White', origin: 'Georgia (Kakheti)' },
  'Anavren': { color: 'Red', origin: 'Kazakhstan (local variety)' },

  // ===== Greece / Eastern Mediterranean =====
  'Assyrtiko': { color: 'White', origin: 'Greece (Santorini)', desc: 'Santorini\'s volcanic white — bone-dry, saline and citrus-charged, keeping razor acidity in extreme heat; Greece\'s most celebrated grape.', chars: ['saline', 'citrus', 'volcanic', 'bone-dry'], aging: 'Very good' },
  'Xinomavro': { color: 'Red', origin: 'Greece (Naoussa)', desc: '"Acid-black" — Naoussa\'s answer to Nebbiolo, pale yet fiercely structured with tomato-leaf, olive and dried-flower complexity.', chars: ['tomato leaf', 'olive', 'high acid + tannin'], aging: 'Excellent — 20+ years' },
  'Agiorgitiko': { color: 'Red', origin: 'Greece (Nemea)', desc: 'St George\'s grape of Nemea — velvety black-cherry and sweet-spice reds from charming to seriously structured.', chars: ['black cherry', 'sweet spice', 'velvety'], aging: 'Good' },
  'Moschofilero': { color: 'White', origin: 'Greece (Mantinia)' },
  'Roditis': { color: 'White', origin: 'Greece (Peloponnese)' },
  'Vidiano': { color: 'White', origin: 'Greece (Crete)' },
  'Avgoustiatis': { color: 'Red', origin: 'Greece (Zakynthos / Samos)' },
  'Mavro Kalavrytino': { color: 'Red', origin: 'Greece (Achaia)' },
  'Boğazkere': { color: 'Red', origin: 'Turkey (Southeastern Anatolia)' },

  // ===== North American hybrids & natives =====
  'Vidal Blanc': { color: 'White', origin: 'France (hybrid; Canadian icewine)', desc: 'French hybrid whose thick skins survive deep frost — the defining grape of Canadian icewine, balancing intense peach-apricot sweetness with fresh acidity.', chars: ['peach', 'apricot', 'icewine', 'winter-hardy'], aging: 'Icewine ages very well' },
  'Baco Noir': { color: 'Red', origin: 'France (hybrid; N. America)' },
  'Maréchal Foch': { color: 'Red', origin: 'France (hybrid; N. America)' },
  'Marquette': { color: 'Red', origin: 'United States (Minnesota hybrid)' },
  'Frontenac': { color: 'Red', origin: 'United States (Minnesota hybrid)' },
  'Frontenac Blanc': { color: 'White', origin: 'United States (Frontenac mutation)' },
  'Frontenac Gris': { color: 'White', origin: 'United States (Frontenac mutation)' },
  'De Chaunac': { color: 'Red', origin: 'France (hybrid; N. America)' },
  'Chancellor': { color: 'Red', origin: 'France (hybrid; N. America)' },
  'Chambourcin': { color: 'Red', origin: 'France (hybrid; N. America)' },
  'Vignoles': { color: 'White', origin: 'France (hybrid; N. America)' },
  'Cayuga White': { color: 'White', origin: 'United States (Cornell hybrid)' },
  'Concord': { color: 'Red', origin: 'United States (Vitis labrusca)' },
  'Catawba': { color: 'Red', origin: 'United States (labrusca hybrid)' },
  'Delaware': { color: 'White', origin: 'United States (labrusca hybrid)' },
  'Niagara': { color: 'White', origin: 'United States (labrusca hybrid)' },

  // ===== South Africa / South America / other =====
  'Pinotage': { color: 'Red', origin: 'South Africa (1925 Pinot Noir × Cinsault)', desc: 'South Africa\'s own crossing — smoky plum and bramble with a savoury, sometimes tarry edge; modern examples range from juicy to age-worthy.', chars: ['smoky', 'plum', 'bramble'], aging: 'Good' },
  'Carmenère': { color: 'Red', origin: 'France (Bordeaux; now Chile)', desc: 'Bordeaux\'s lost grape, rediscovered in Chile masquerading as Merlot — dark fruit with paprika, tomato-leaf and mocha when fully ripe.', chars: ['dark fruit', 'paprika', 'mocha'], aging: 'Good' },
};

// ---------------------------------------------------------------------------
// COUNTRIES — [name]: { code, desc }
// ---------------------------------------------------------------------------
const C = {
  'France': { code: 'FR', desc: 'The reference point for fine wine: Bordeaux, Burgundy, Champagne, the Rhône, Loire and Alsace between them defined most of the world\'s benchmark styles, codified in the AOC system.' },
  'Italy': { code: 'IT', desc: 'The world\'s largest wine producer, with more native grape varieties than any other country — from Piedmont\'s Nebbiolo and Tuscany\'s Sangiovese to Etna\'s volcanic crus.' },
  'United States': { code: 'US', desc: 'The fourth-largest producer, led overwhelmingly by California (Napa, Sonoma, Central Coast) with world-class Pinot Noir and Riesling from Oregon, Washington and New York.' },
  'Germany': { code: 'DE', desc: 'Home of Riesling and of the world\'s great steep-slope vineyards along the Mosel and Rhine; the Prädikat system grades ripeness from Kabinett to Trockenbeerenauslese.' },
  'Spain': { code: 'ES', desc: 'The world\'s most widely planted vineyard area — Tempranillo-led Rioja and Ribera del Duero, Priorat\'s slate terraces, Albariño\'s Atlantic whites and the solera-aged wonders of Jerez.' },
  'Portugal': { code: 'PT', desc: 'Far more than Port: the Douro\'s terraced reds, Vinho Verde\'s crisp whites and Madeira\'s immortal fortifieds, all built on a treasury of native grapes.' },
  'Australia': { code: 'AU', desc: 'From Barossa Shiraz and Coonawarra Cabernet to Hunter Semillon and cool-climate Yarra Pinot Noir — some of the oldest producing vines on earth.' },
  'New Zealand': { code: 'NZ', desc: 'Marlborough Sauvignon Blanc redefined the grape worldwide; Central Otago Pinot Noir, Hawke\'s Bay Syrah and Bordeaux blends complete the picture.' },
  'Argentina': { code: 'AR', desc: 'High-altitude Mendoza made Malbec a global star; Salta\'s dizzying vineyards and aromatic Torrontés add range.' },
  'Chile': { code: 'CL', desc: 'A phylloxera-free viticultural paradise between Andes and Pacific — Cabernet and Carmenère in Maipo and Colchagua, coastal Sauvignon and old-vine País in the south.' },
  'South Africa': { code: 'ZA', desc: 'Three centuries of winegrowing around the Cape — Stellenbosch Cabernet, Swartland\'s old-vine Chenin and Syrah, and the historic sweet wines of Constantia.' },
  'Austria': { code: 'AT', desc: 'Precise, mineral whites — above all Grüner Veltliner and Riesling from the Wachau and Kamptal — plus Burgenland\'s Blaufränkisch reds and noble sweet wines.' },
  'Canada': { code: 'CA', desc: 'The world\'s icewine leader (Niagara Peninsula Vidal and Riesling), with serious dry wines from Ontario and British Columbia\'s Okanagan Valley.' },
  'Greece': { code: 'GR', desc: 'One of wine\'s oldest cultures, resurgent through native grapes: Assyrtiko on volcanic Santorini, Xinomavro in Naoussa and Agiorgitiko in Nemea.' },
  'Switzerland': { code: 'CH', desc: 'Alpine vineyards from Lake Geneva\'s Chasselas terraces to the Valais, where Petite Arvine and Cornalin are jealously kept — little is exported.' },
  'Hungary': { code: 'HU', desc: 'Tokaj\'s botrytised Aszú was the first classified wine region in the world (1737); dry Furmint and the reds of Villány lead the modern revival.' },
  'Croatia': { code: 'HR', desc: 'Istrian Malvazija and Teran in the north, Plavac Mali on Dalmatia\'s sun-baked slopes — and the original home of Zinfandel (Tribidrag).' },
  'Georgia': { code: 'GE', desc: 'Eight thousand vintages: the cradle of wine, still fermenting Saperavi and Rkatsiteli in buried qvevri, a method on UNESCO\'s heritage list.' },
  'England': { code: 'GB', desc: 'Chalk downs geologically twinned with Champagne now yield world-class traditional-method sparkling wine from Kent and Sussex.' },
  'Japan': { code: 'JP', desc: 'Delicate Koshu whites and Muscat Bailey A reds from Yamanashi and beyond, grown with meticulous precision in a challenging monsoon climate.' },
  'Lebanon': { code: 'LB', desc: 'The Bekaa Valley\'s high vineyards continue a wine culture older than the Phoenicians, led by long-lived Rhône-style reds.' },
  'Israel': { code: 'IL', desc: 'A modern industry re-founded on Golan and Galilee altitude, producing polished Mediterranean-climate reds and whites.' },
  'Mexico': { code: 'MX', desc: 'The Americas\' oldest wine country, re-energised by Valle de Guadalupe\'s Mediterranean-style reds — and Jalisco\'s high-altitude experiments.' },
  'Brazil': { code: 'BR', desc: 'Serra Gaúcha\'s Italian-immigrant vineyards make Brazil a serious sparkling-wine producer.' },
  'Uruguay': { code: 'UY', desc: 'Atlantic-cooled vineyards where Tannat found a gentler, velvet-textured second home.' },
  'Netherlands': { code: 'NL', desc: 'A small but growing cool-climate industry in Limburg and Gelderland, largely built on fungus-resistant (PIWI) varieties.' },
  'Belgium': { code: 'BE', desc: 'Chalk soils in Hainaut and Limburg support a fast-growing sparkling and PIWI white scene.' },
  'Sweden': { code: 'SE' },
  'Norway': { code: 'NO', desc: 'Fjord-side plots at the latitude limit of viticulture, pioneering Solaris in a warming climate.' },
  'Turkey': { code: 'TR', desc: 'One of the world\'s largest grape growers, with an ancient wine culture reviving through native Boğazkere, Öküzgözü and Narince.' },
  'Morocco': { code: 'MA', desc: 'North Africa\'s quality leader — Atlas-foothill reds from Rhône varieties, a legacy of French planting refreshed by modern investment.' },
  'Kazakhstan': { code: 'KZ', desc: 'Revived vineyards in the Assa Valley foothills near Almaty, blending international and local varieties at altitude.' },
  'Lithuania': { code: 'LT', desc: 'A nascent cold-climate producer working with hardy hybrid varieties.' },
  'Latvia': { code: 'LV', desc: 'Micro-scale northern viticulture built on winter-hardy hybrids.' },
  'Dominican Republic': { code: 'DO', desc: 'Tropical viticulture around Puerto Plata — one of the Caribbean\'s few wine ventures.' },
  'Serbia': { code: 'RS', desc: 'Šumadija and Fruška Gora lead a quality revival built on Prokupac and international varieties.' },
  'Bulgaria': { code: 'BG', desc: 'Thracian-valley reds from Mavrud and international grapes, heirs to one of Europe\'s oldest wine cultures.' },
  'Armenia': { code: 'AM', desc: 'Six-thousand-year-old winemaking (the Areni-1 cave) reborn through high-altitude Areni Noir.' },
  'Ukraine': { code: 'UA', desc: 'Black Sea and Crimean traditions spanning dry wines and the historic fortified cellars of Massandra.' },
  'Czech Republic': { code: 'CZ', desc: 'Moravia\'s limestone slopes produce aromatic whites — Grüner Veltliner, Riesling and Pálava.' },
  'Slovakia': { code: 'SK', desc: 'The Lesser Carpathians and a corner of the Tokaj region give fresh whites and noble sweet wines.' },
  'Luxembourg': { code: 'LU', desc: 'Moselle-bank Rieslings, Auxerrois and Crémant de Luxembourg from Europe\'s smallest historic wine country.' },
  'North Macedonia': { code: 'MK', desc: 'The Tikveš valley\'s sun makes powerful Vranec reds the national signature.' },
  'Kosovo': { code: 'XK', desc: 'The Rahovec valley carries a long tradition of red and rosé winegrowing.' },
  'Poland': { code: 'PL', desc: 'A fast-growing cool-climate scene of PIWI whites and sparkling wine in the southwest.' },
};

// ---------------------------------------------------------------------------
// REGIONS — [country]: { [name]: desc }
// ---------------------------------------------------------------------------
const R = {
  'France': {
    'Burgundy': 'The world\'s most parcellated wine region: Pinot Noir and Chardonnay expressed through a thousand-year-old hierarchy of climats, from Chablis in the north through the Côte d\'Or to the Mâconnais.',
    'Champagne': 'The chalk hills east of Paris that define sparkling wine — Pinot Noir, Meunier and Chardonnay transformed by the traditional method and long lees aging.',
    'Rhône Valley': 'Two regions in one: the granite hill of Syrah in the north (Côte-Rôtie, Hermitage), and the sun-drenched Grenache blends of the south, crowned by Châteauneuf-du-Pape.',
    'Northern Rhône': 'A narrow granite corridor where Syrah reaches its apogee — Côte-Rôtie, Hermitage, Cornas — plus Viognier\'s home in Condrieu.',
    'Southern Rhône': 'Warm, garrigue-scented Grenache country: Châteauneuf-du-Pape, Gigondas, Vacqueyras and a sea of excellent Côtes-du-Rhône.',
    'Loire Valley': 'A thousand-kilometre river of diversity: Muscadet at the Atlantic, Chenin\'s Vouvray and Savennières, Cabernet Franc in Chinon, and Sancerre\'s flinty Sauvignon.',
    'Alsace': 'Sheltered by the Vosges, France\'s driest region grows aromatic varietal whites — Riesling, Gewurztraminer, Pinot Gris — on a mosaic of grand cru terroirs.',
    'Languedoc-Roussillon': 'France\'s vast, reborn south — old-vine Carignan and Grenache from schist and garrigue, plus the fortified Muscats and Grenaches of Roussillon.',
    'Languedoc': 'The Mediterranean crescent from Nîmes to Narbonne, where crus like Pic Saint-Loup, Terrasses du Larzac and La Clape now lead France\'s best-value quality revolution.',
    'Roussillon': 'French Catalonia: black schist, dry winds and ancient bush vines, source of profound dry Grenache and the fortified vins doux naturels of Banyuls and Maury.',
    'Provence': 'The world\'s rosé benchmark, plus Bandol\'s serious Mourvèdre reds beneath the Mediterranean light.',
    'Jura': 'A tiny mountain region of huge originality — oxidative Vin Jaune from Savagnin, ethereal Poulsard and Trousseau reds, and Vin de Paille.',
    'Southwest France': 'A federation of characterful appellations between Bordeaux and the Pyrenees: Cahors Malbec, Madiran Tannat and Jurançon\'s Manseng whites.',
    'Beaujolais': null, // description already curated on prod
    'Bordeaux': null,
  },
  'Italy': {
    'Tuscany': 'Sangiovese\'s homeland — Chianti Classico, Brunello di Montalcino and Vino Nobile — alongside the coastal Super Tuscans of Bolgheri and the Maremma.',
    'Piedmont': null,
    'Veneto': 'From Soave\'s volcanic whites to Valpolicella and the dried-grape majesty of Amarone, plus the Prosecco hills of Valdobbiadene.',
    'Sicily': 'The Mediterranean\'s largest island: Etna\'s high lava terraces (Nerello Mascalese, Carricante), Vittoria\'s Frappato and the west\'s Grillo and Nero d\'Avola.',
    'Campania': 'Volcanic soils and ancient grapes around Naples — Taurasi\'s Aglianico, Fiano di Avellino and Greco di Tufo.',
    'Puglia': 'Italy\'s heel: sun-loaded Primitivo di Manduria and Salice Salentino from old bush vines on iron-red soils.',
    'Friuli-Venezia Giulia': 'Italy\'s white-wine frontier with Slovenia — Friulano, Ribolla Gialla and pioneering skin-contact wines from Collio and the Carso.',
    'Lombardy': 'Home of Franciacorta, Italy\'s finest traditional-method sparkler, plus Valtellina\'s alpine Nebbiolo and Lugana\'s lakeside whites.',
    'Alto Adige (Südtirol)': 'Alpine-Mediterranean crossroads: taut Pinot Bianco, aromatic Gewürztraminer (born in Tramin) and silky Schiava and Lagrein reds.',
    'Emilia-Romagna': 'The land of Lambrusco\'s joyful fizz and Romagna\'s Sangiovese, stretching from the Po plain to the Apennines.',
    'Umbria': 'Italy\'s green heart — Orvieto\'s whites and the massive, tannic Sagrantino di Montefalco.',
    'Marche': 'Adriatic hills producing Verdicchio, one of Italy\'s greatest and most ageworthy white grapes.',
    'Abruzzo': null,
  },
  'Spain': {
    'Rioja': 'Spain\'s most storied region: Tempranillo blends aged long in American and French oak, graded Crianza to Gran Reserva, from Atlantic-cooled hills along the Ebro.',
    'Castilla y León': 'The high Duero plateau — Ribera del Duero\'s powerful Tempranillo, Rueda\'s Verdejo, Toro\'s muscular reds and Bierzo\'s Mencía.',
    'Catalonia': 'From Cava\'s Penedès heartland to Priorat\'s heroic slate terraces of old-vine Garnacha and Cariñena.',
    'Galicia': 'Green, Atlantic Spain: Rías Baixas Albariño, Ribeira Sacra\'s canyon-grown Mencía and Valdeorras Godello.',
    'Andalusia': 'The solera country of Jerez and Montilla-Moriles — fino, amontillado, oloroso and PX, wines without parallel anywhere.',
    'Castilla-La Mancha': 'The vast central plateau, the world\'s largest vine surface, source of Airén, Tempranillo (Cencibel) and rising-value estates.',
  },
  'Germany': {
    'Mosel': 'The world\'s steepest vineyards, on blue and red slate above the winding river — feather-light, racy Rieslings of unrivalled delicacy and longevity.',
    'Pfalz': 'Germany\'s sunny, almost Mediterranean Riesling powerhouse north of Alsace, equally strong in dry Riesling and the Pinot family.',
    'Rheinhessen': 'Germany\'s largest region, transformed by a young-grower revolution — the Roter Hang\'s red-slate Rieslings lead.',
    'Rheingau': 'A single south-facing Rhine bank of aristocratic Riesling estates; birthplace of Spätlese and the Verband der Prädikatsweingüter.',
    'Nahe': 'A geological mosaic between Mosel and Rheinhessen giving Rieslings that combine Mosel finesse with Rhine body.',
    'Baden': 'Germany\'s warmest region, opposite Alsace — the country\'s Pinot Noir (Spätburgunder) capital.',
    'Franken': 'Silvaner\'s spiritual home, bottled in the round Bocksbeutel, from limestone slopes around Würzburg.',
    'Ahr': 'A tiny slate valley improbably far north that specialises in elegant Spätburgunder.',
  },
  'United States': {
    'California': 'The engine of American wine — from Napa and Sonoma benchmarks through Central Coast Rhône and Burgundy varieties to old-vine Zinfandel.',
    'Napa Valley': 'America\'s most famous appellation: Cabernet Sauvignon from a corridor of volcanic and alluvial soils between the Mayacamas and Vaca ranges.',
    'Sonoma County': 'Napa\'s cooler, more varied neighbour — Russian River Pinot Noir and Chardonnay, Dry Creek Zinfandel, Sonoma Coast elegance.',
    'Central Coast': 'From Monterey to Santa Barbara: fog-cooled Chardonnay and Pinot Noir plus Paso Robles\' Rhône movement.',
    'Oregon': 'The Willamette Valley\'s volcanic and marine soils produce America\'s most Burgundian Pinot Noir and Chardonnay.',
    'Washington': 'Columbia Valley\'s desert sunshine and cool nights give concentrated, structured Cabernet, Merlot and Syrah.',
    'Finger Lakes': 'Deep glacial lakes moderate a cold climate to produce America\'s finest Riesling.',
    'New York': 'From the Finger Lakes to Long Island — Riesling, Cabernet Franc and traditional-method sparkling.',
  },
  'Australia': {
    'Barossa Valley': 'The heartland of Australian Shiraz, with some of the world\'s oldest vines on their own roots — opulent, chocolatey reds plus Eden Valley\'s Riesling heights.',
    'South Australia': 'The country\'s wine engine room: Barossa, Clare, McLaren Vale, Coonawarra and the Adelaide Hills in one state.',
    'Clare Valley': 'Australia\'s Riesling stronghold — lime-scented, bone-dry wines that age for decades — alongside sturdy Shiraz and Cabernet.',
    'Hunter Valley': 'Australia\'s oldest region, famous for a paradox: low-alcohol Semillon that ages into honeyed splendour in a subtropical climate.',
    'Margaret River': 'Maritime Western Australia — Cabernet blends and Chardonnay of remarkable poise.',
    'McLaren Vale': 'Mediterranean coastal district south of Adelaide, prized for generous Shiraz and Grenache from ancient soils.',
    'Yarra Valley': 'Cool-climate Victoria — refined Pinot Noir, Chardonnay and sparkling wine on Melbourne\'s doorstep.',
    'Adelaide Hills': 'High, cool ridges giving crisp Sauvignon Blanc, Chardonnay and elegant Shiraz.',
  },
  'New Zealand': {
    'Marlborough': 'The region that made New Zealand famous — explosively aromatic Sauvignon Blanc from the Wairau and Awatere valleys, plus fine Pinot Noir and sparkling.',
    'Central Otago': 'The world\'s southernmost fine-wine region: alpine schist and fierce light produce dark, perfumed Pinot Noir.',
    'Hawke\'s Bay': 'The country\'s Bordeaux-and-Syrah capital, centred on the free-draining Gimblett Gravels.',
    'Gisborne': 'Sunny east-coast Chardonnay country, first in the world to see each vintage\'s sunrise.',
    'Martinborough': 'A small terrace at the North Island\'s foot producing some of NZ\'s most sought-after Pinot Noir.',
    'Canterbury': 'Limestone-influenced Pinot Noir and aromatic whites, led by the Waipara subregion.',
    'Nelson': 'Sun-drenched boutique region across the ranges from Marlborough — aromatics and Pinot Noir.',
  },
  'Portugal': {
    'Douro': 'The world\'s oldest demarcated region (1756): dizzying schist terraces above the river yield Port and, increasingly, some of Europe\'s greatest dry reds.',
    'Vinho Verde': 'The cool, green northwest — light, saline whites from Alvarinho, Loureiro and friends, made for the table.',
    'Alentejo': 'Rolling cork-oak plains of southern Portugal producing generous, sun-filled reds and characterful whites.',
    'Dão': 'Granite highlands ringed by mountains — elegant, pine-scented reds from Touriga Nacional and Jaen, and mineral Encruzado whites.',
    'Bairrada': 'Atlantic limestone country of the tannic Baga grape and excellent traditional-method sparkling.',
    'Azores': 'Vines in volcanic rock corrals (currais) on Pico island — salty, tense whites from Arinto dos Açores; a UNESCO landscape.',
    'Setúbal Peninsula': 'Home of Moscatel de Setúbal, one of the world\'s great fortified Muscats, plus Castelão reds from Palmela\'s sands.',
  },
  'Austria': {
    'Wachau': 'A UNESCO stretch of the Danube with primary-rock terraces — Austria\'s most celebrated Grüner Veltliner and Riesling, graded Steinfeder to Smaragd.',
    'Burgenland': 'Warm Pannonian east — Blaufränkisch reds of increasing world renown and the nobly sweet wines of Neusiedlersee.',
    'Niederösterreich': 'Lower Austria, the Danube heartland: Wachau, Kremstal, Kamptal and Weinviertel, dominated by Grüner Veltliner.',
    'Kamptal': 'Kammern\'s famous Heiligenstein hill anchors this Danube-tributary region of taut Riesling and Grüner Veltliner.',
  },
  'South Africa': {
    'Stellenbosch': 'The Cape\'s classic quarter — mountain-flanked Cabernet Sauvignon and blends of consistent world class.',
    'Swartland': 'Dry-farmed old bush vines on granite and schist, engine of South Africa\'s new-wave Chenin and Syrah movement.',
    'Western Cape': 'The umbrella of nearly all South African wine, from Constantia\'s sea-cooled slopes to the Olifants River.',
    'Constantia': 'The Cape\'s original vineyard (1685), famous for the legendary sweet Vin de Constance and maritime Sauvignon Blanc.',
  },
  'Argentina': {
    'Mendoza': 'Argentina\'s wine capital in the Andes rain shadow — Malbec from Luján de Cuyo and the high Uco Valley defines the country.',
    'Salta': 'Among the world\'s highest vineyards (up to 3,000 m) around Cafayate — intense Malbec and floral Torrontés.',
    'Uco Valley': 'Mendoza\'s high-altitude frontier — calcareous soils and mountain light giving Argentina\'s most refined Malbec.',
  },
  'Chile': {
    'Central Valley': 'Chile\'s broad backbone from Maipo to Maule — reliable Cabernet, Carmenère and old dry-farmed vines in the south.',
    'Colchagua Valley': 'Warm, prestigious red-wine valley — powerful Cabernet, Carmenère and Syrah.',
    'Maipo Valley': 'Santiago\'s historic vineyard belt, home of Chile\'s aristocratic Cabernet Sauvignons.',
  },
  'Canada': {
    'Niagara Peninsula': 'Lake-moderated Ontario benchland — the world\'s largest icewine producer, plus increasingly fine Chardonnay, Riesling and Pinot Noir.',
    'Okanagan Valley': 'British Columbia\'s dramatic desert-lake valley, from crisp whites in the north to bold reds on the Osoyoos border.',
    'Quebec': 'Hardy hybrids and icewine/ice cider from a fiercely continental climate.',
    'Ontario': 'Canada\'s largest wine province — Niagara Peninsula, Prince Edward County and Lake Erie North Shore.',
  },
  'Greece': {
    'Peloponnese': 'Nemea\'s Agiorgitiko and Mantinia\'s Moschofilero lead the southern mainland\'s revival.',
    'Macedonia': 'Northern Greece — Naoussa and Amyndeon, kingdom of the ageworthy Xinomavro.',
    'Crete': 'The island\'s revival rests on native Vidiano, Liatiko and Kotsifali from high mountain vineyards.',
  },
  'Hungary': {
    'Tokaj': 'The world\'s first classified wine region (1737) — volcanic hills where botrytised Furmint becomes Aszú, the "wine of kings".',
    'Villány': 'Hungary\'s warmest region, making its most acclaimed reds from Cabernet Franc and Kékfrankos.',
  },
  'Georgia': {
    'Kakheti': 'Georgia\'s eastern heartland where most qvevri wine is made — amber Rkatsiteli and dark Saperavi.',
  },
  'Lebanon': {
    'Bekaa Valley': 'High-altitude vineyards between two mountain ranges — the historic home of Château Musar and Lebanon\'s Rhône-style reds.',
  },
  'England': {
    'Kent': 'Chalk and greensand slopes in England\'s sunniest corner — a leading county for traditional-method sparkling wine.',
    'West Sussex': 'South Downs chalk mirroring Champagne\'s geology; home to several of England\'s flagship sparkling estates.',
  },
  'Sweden': {
    'Skåne': null, // curated on prod
  },
};

const stats = { set: 0, skippedFilled: 0, missing: 0 };
const APPLY_TAG = APPLY ? '✔' : '[dry]';

async function enrichGrapes() {
  console.log('== Grapes ==');
  for (const [name, data] of Object.entries(G)) {
    const grape = await Grape.findOne({ normalizedName: normalizeString(name) });
    if (!grape) { stats.missing += 1; console.log(`  – not in DB: ${name}`); continue; }
    const updates = [];
    if (!grape.color && data.color) { grape.color = data.color; updates.push('color'); }
    if (!grape.origin && data.origin) { grape.origin = data.origin; updates.push('origin'); }
    if (!grape.description && data.desc) { grape.description = data.desc; updates.push('description'); }
    if ((!grape.characteristics || grape.characteristics.length === 0) && data.chars) {
      grape.characteristics = data.chars; updates.push('characteristics');
    }
    if (!grape.agingPotential && data.aging) { grape.agingPotential = data.aging; updates.push('aging'); }
    if (updates.length === 0) { stats.skippedFilled += 1; continue; }
    stats.set += 1;
    console.log(`${APPLY_TAG} ${name}: ${updates.join(', ')}`);
    if (APPLY) await grape.save();
  }
}

async function enrichCountries() {
  console.log('\n== Countries ==');
  for (const [name, data] of Object.entries(C)) {
    const country = await Country.findOne({ normalizedName: normalizeString(name) });
    if (!country) { stats.missing += 1; console.log(`  – not in DB: ${name}`); continue; }
    const updates = [];
    if (!country.code && data.code) { country.code = data.code; updates.push('code'); }
    if (!country.description && data.desc) { country.description = data.desc; updates.push('description'); }
    if (updates.length === 0) { stats.skippedFilled += 1; continue; }
    stats.set += 1;
    console.log(`${APPLY_TAG} ${name}: ${updates.join(', ')}`);
    if (APPLY) await country.save();
  }
}

async function enrichRegions() {
  console.log('\n== Regions ==');
  for (const [countryName, regions] of Object.entries(R)) {
    const country = await Country.findOne({ normalizedName: normalizeString(countryName) });
    if (!country) { stats.missing += 1; console.log(`  – country not in DB: ${countryName}`); continue; }
    for (const [regionName, desc] of Object.entries(regions)) {
      if (!desc) continue; // null marks an already-curated description
      const region = await Region.findOne({
        country: country._id,
        normalizedName: normalizeString(regionName),
      });
      if (!region) { stats.missing += 1; console.log(`  – not in DB: ${regionName} (${countryName})`); continue; }
      if (region.description) { stats.skippedFilled += 1; continue; }
      stats.set += 1;
      console.log(`${APPLY_TAG} ${regionName} (${countryName}): description`);
      if (APPLY) {
        region.description = desc;
        await region.save();
      }
    }
  }
}

async function run() {
  const uri = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  await enrichGrapes();
  await enrichCountries();
  await enrichRegions();

  console.log(`\nSummary: ${stats.set} documents enriched, ${stats.skippedFilled} already complete, ${stats.missing} not found in DB.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Enrichment failed:', err);
  process.exit(1);
});
