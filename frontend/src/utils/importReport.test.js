import { summariseImportOutcome, csvEscape, buildOutcomeRows, buildImportReportCsv } from './importReport';

// Validation-result row helper (the shape ImportBottles keeps in `results`)
const row = (index, wineName, producer, vintage) => ({
  index,
  item: { wineName, producer, vintage },
});

describe('summariseImportOutcome', () => {
  it('reports full success only when every row became a bottle', () => {
    const out = summariseImportOutcome(
      { created: 3, total: 3, skipped: [], errors: [], unplaced: [] },
      0
    );
    expect(out.fullSuccess).toBe(true);
    expect(out.created).toBe(3);
    expect(out.totalRows).toBe(3);
    expect(out.missedCount).toBe(0);
  });

  it('is not full success when the backend skipped a row', () => {
    const out = summariseImportOutcome(
      { created: 2, total: 3, skipped: [{ index: 1, reason: 'No wine selected' }], errors: [], unplaced: [] },
      0
    );
    expect(out.fullSuccess).toBe(false);
    expect(out.skippedCount).toBe(1);
  });

  it('is not full success when the user skipped rows at review', () => {
    // 2 submitted + created, but 1 was skipped by hand: 2 of 3 imported
    const out = summariseImportOutcome(
      { created: 2, total: 2, skipped: [], errors: [], unplaced: [] },
      1
    );
    expect(out.fullSuccess).toBe(false);
    expect(out.totalRows).toBe(3);
    expect(out.skippedCount).toBe(1);
    expect(out.missedCount).toBe(1);
  });

  it('is not full success when a bottle imported but could not be placed', () => {
    const out = summariseImportOutcome(
      { created: 3, total: 3, skipped: [], errors: [], unplaced: [{ sourceIndex: 0, rackName: 'A', requestedPosition: 4, reason: 'Slot occupied' }] },
      0
    );
    expect(out.fullSuccess).toBe(false);
    expect(out.unplacedCount).toBe(1);
    // ...but the miss count (rows that did NOT import) stays 0
    expect(out.missedCount).toBe(0);
  });

  it('handles a missing importResult without blowing up', () => {
    const out = summariseImportOutcome(null, 0);
    expect(out.fullSuccess).toBe(false);
    expect(out.created).toBe(0);
    expect(out.totalRows).toBe(0);
  });
});

describe('csvEscape', () => {
  it('passes plain values through untouched', () => {
    expect(csvEscape('Margaux')).toBe('Margaux');
    expect(csvEscape(2015)).toBe('2015');
  });

  it('quotes commas and doubles inner quotes', () => {
    expect(csvEscape('Château Margaux, Premier Cru')).toBe('"Château Margaux, Premier Cru"');
    expect(csvEscape('The "Special" Cuvée')).toBe('"The ""Special"" Cuvée"');
  });

  it('quotes newlines and renders null/undefined as empty', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });
});

describe('buildOutcomeRows', () => {
  it('maps backend indices through submittedRows back to original file rows', () => {
    // Original file rows 0..3; row 1 was user-skipped, so submitted = [0, 2, 3]
    const submittedRows = [row(0, 'Wine A', 'Prod A', 2018), row(2, 'Wine C', 'Prod C', 2020), row(3, 'Wine D', 'Prod D', null)];
    const userSkippedRows = [row(1, 'Wine B', 'Prod B', 2019)];
    const importResult = {
      created: 1,
      total: 3,
      skipped: [{ index: 1, reason: 'No wine selected' }], // submitted idx 1 → file row 2
      errors: [{ index: 2, reason: 'Invalid vintage' }],   // submitted idx 2 → file row 3
      unplaced: [],
    };

    const rows = buildOutcomeRows({ importResult, submittedRows, userSkippedRows });
    expect(rows).toEqual([
      { index: 2, wineName: 'Wine B', producer: 'Prod B', vintage: 2019, outcome: 'skipped', reason: 'Skipped during review' },
      { index: 3, wineName: 'Wine C', producer: 'Prod C', vintage: 2020, outcome: 'skipped', reason: 'No wine selected' },
      { index: 4, wineName: 'Wine D', producer: 'Prod D', vintage: '', outcome: 'error', reason: 'Invalid vintage' },
    ]);
  });

  it('includes unplaced bottles with rack context and honors a custom skip reason', () => {
    const submittedRows = [row(0, 'Wine A', 'Prod A', 2018)];
    const importResult = {
      created: 1,
      total: 1,
      skipped: [],
      errors: [],
      unplaced: [{ sourceIndex: 0, rackName: 'Cellar Rack', requestedPosition: 12, reason: 'Slot occupied' }],
    };
    const rows = buildOutcomeRows({
      importResult,
      submittedRows,
      userSkippedRows: [row(5, 'Wine F', 'Prod F', 2021)],
      userSkippedReason: 'Överhoppad vid granskning',
    });
    expect(rows[0]).toEqual({
      index: 1, wineName: 'Wine A', producer: 'Prod A', vintage: 2018,
      outcome: 'unplaced',
      reason: 'Imported, but not placed in rack "Cellar Rack": Slot occupied',
    });
    expect(rows[1].reason).toBe('Överhoppad vid granskning');
  });

  it('still emits a row when the index cannot be mapped', () => {
    const importResult = {
      created: 0, total: 1,
      skipped: [], errors: [],
      unplaced: [{ sourceIndex: null, rackName: 'A', requestedPosition: 3, reason: 'Rack save failed' }],
    };
    const rows = buildOutcomeRows({ importResult, submittedRows: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe('');
    expect(rows[0].outcome).toBe('unplaced');
  });
});

describe('buildImportReportCsv', () => {
  it('produces the exact summary, header and data lines', () => {
    const submittedRows = [row(0, 'Wine A', 'Prod A', 2018), row(2, 'Wine C', 'Château "C", Fils', 2020)];
    const userSkippedRows = [row(1, 'Wine B', 'Prod B', 2019)];
    const importResult = {
      created: 1,
      total: 2,
      skipped: [],
      errors: [{ index: 1, reason: 'Invalid vintage' }],
      unplaced: [],
    };

    const csv = buildImportReportCsv({ importResult, submittedRows, userSkippedRows });
    expect(csv.split('\r\n')).toEqual([
      '# Import report: 1 of 3 rows imported (1 skipped, 1 errors, 0 imported but unplaced)',
      'index,wineName,producer,vintage,outcome,reason',
      '2,Wine B,Prod B,2019,skipped,Skipped during review',
      '3,Wine C,"Château ""C"", Fils",2020,error,Invalid vintage',
      '',
    ]);
  });

  it('on a clean import still emits the summary and header with no data rows', () => {
    const csv = buildImportReportCsv({
      importResult: { created: 2, total: 2, skipped: [], errors: [], unplaced: [] },
      submittedRows: [row(0, 'A', 'P', 2018), row(1, 'B', 'Q', 2019)],
      userSkippedRows: [],
    });
    expect(csv).toBe(
      '# Import report: 2 of 2 rows imported (0 skipped, 0 errors, 0 imported but unplaced)\r\n' +
      'index,wineName,producer,vintage,outcome,reason\r\n'
    );
  });
});
