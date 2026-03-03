/**
 * ISO 3166-1 alpha-2 → numeric code lookup.
 * Numeric codes are stored without leading zeros to match the world-atlas
 * TopoJSON feature IDs (which are JSON numbers, e.g. 250 for France, 4 for Afghanistan).
 *
 * Used by the WorldMapChart to correlate country ISO alpha-2 codes from the
 * stats API with the topology geometry IDs from world-atlas/countries-110m.json.
 */
const A2_TO_NUM = {
  AD:'20',  AE:'784', AF:'4',   AG:'28',  AL:'8',   AM:'51',  AO:'24',
  AR:'32',  AT:'40',  AU:'36',  AZ:'31',
  BA:'70',  BB:'52',  BD:'50',  BE:'56',  BF:'854', BG:'100', BH:'48',
  BI:'108', BJ:'204', BN:'96',  BO:'68',  BR:'76',  BS:'44',  BT:'64',
  BW:'72',  BY:'112', BZ:'84',
  CA:'124', CD:'180', CF:'140', CG:'178', CH:'756', CI:'384', CL:'152',
  CM:'120', CN:'156', CO:'170', CR:'188', CU:'192', CV:'132', CY:'196',
  CZ:'203',
  DE:'276', DJ:'262', DK:'208', DM:'212', DO:'214', DZ:'12',
  EC:'218', EE:'233', EG:'818', ER:'232', ES:'724', ET:'231',
  FI:'246', FJ:'242', FR:'250',
  GA:'266', GB:'826', GD:'308', GE:'268', GH:'288', GL:'304', GM:'270',
  GN:'324', GQ:'226', GR:'300', GT:'320', GW:'624', GY:'328',
  HN:'340', HR:'191', HT:'332', HU:'348',
  ID:'360', IE:'372', IL:'376', IN:'356', IQ:'368', IR:'364', IS:'352',
  IT:'380',
  JM:'388', JO:'400', JP:'392',
  KE:'404', KG:'417', KH:'116', KM:'174', KP:'408', KR:'410', KW:'414',
  KZ:'398',
  LA:'418', LB:'422', LI:'438', LK:'144', LR:'430', LS:'426', LT:'440',
  LU:'442', LV:'428', LY:'434',
  MA:'504', MC:'492', MD:'498', ME:'499', MG:'450', MK:'807', ML:'466',
  MM:'104', MN:'496', MR:'478', MT:'470', MU:'480', MV:'462', MW:'454',
  MX:'484', MY:'458', MZ:'508',
  NA:'516', NE:'562', NG:'566', NI:'558', NL:'528', NO:'578', NP:'524',
  NZ:'554',
  OM:'512',
  PA:'591', PE:'604', PG:'598', PH:'608', PK:'586', PL:'616', PT:'620',
  PY:'600',
  QA:'634',
  RO:'642', RS:'688', RU:'643', RW:'646',
  SA:'682', SB:'90',  SC:'690', SD:'729', SE:'752', SG:'702', SI:'705',
  SK:'703', SL:'694', SM:'674', SN:'686', SO:'706', SR:'740', SS:'728',
  ST:'678', SV:'222', SY:'760', SZ:'748',
  TD:'148', TG:'768', TH:'764', TJ:'762', TL:'626', TM:'795', TN:'788',
  TO:'776', TR:'792', TT:'780', TZ:'834',
  UA:'804', UG:'800', US:'840', UY:'858', UZ:'860',
  VA:'336', VE:'862', VN:'704', VU:'548',
  WS:'882',
  YE:'887',
  ZA:'710', ZM:'894', ZW:'716',
};

/**
 * Reverse lookup: ISO numeric string → alpha-2.
 * Keys match the string representation of world-atlas TopoJSON feature IDs.
 * e.g. "250" → "FR", "4" → "AF"
 */
export const NUM_TO_A2 = Object.fromEntries(
  Object.entries(A2_TO_NUM).map(([a2, num]) => [num, a2])
);

export default A2_TO_NUM;
