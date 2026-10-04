/**
 * Receipt scan → import rows.
 *
 * WHY THIS TEST EXISTS:
 * The scan answers per LINE with a quantity, the import page counts BOTTLES.
 * A wrong expansion silently imports one bottle where the receipt says six.
 */
import { describe, it, expect } from 'vitest';
import { expandReceiptItems, groupSkippedLines, receiptErrorKey } from './receiptImport';

describe('expandReceiptItems', () => {
  it('turns each line into one row per bottle and drops quantity', () => {
    const rows = expandReceiptItems([
      { wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', quantity: 2, price: 189, receiptLine: 'FEVRE CHABLIS 22 75CL' },
      { wineName: 'Rioja Reserva', vintage: 'NV', quantity: 1, price: 149 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', price: 189, receiptLine: 'FEVRE CHABLIS 22 75CL' });
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[1]).not.toBe(rows[0]);
    expect(rows[2]).toEqual({ wineName: 'Rioja Reserva', vintage: 'NV', price: 149 });
  });

  it('marks a row without a vintage like a CSV row without one, so the review asks for the year', () => {
    const [row] = expandReceiptItems([{ wineName: 'Barolo', quantity: 1 }]);
    expect(row).toEqual({ wineName: 'Barolo', vintage: 'NV', vintageMissing: true });
  });

  it('treats a missing or odd quantity as one bottle and skips empty rows', () => {
    expect(expandReceiptItems([{ wineName: 'A' }, { wineName: 'B', quantity: 0 }, { wineName: 'C', quantity: 'x' }, {}])).toHaveLength(3);
    expect(expandReceiptItems(null)).toEqual([]);
  });

  it('caps a runaway quantity', () => {
    expect(expandReceiptItems([{ wineName: 'A', quantity: 5000 }])).toHaveLength(1000);
  });
});

describe('groupSkippedLines', () => {
  it('groups by reason, most frequent first', () => {
    expect(groupSkippedLines([
      { line: 'PANT', reason: 'deposit' },
      { line: 'LAGER 33CL', reason: 'beer' },
      { line: 'IPA 50CL', reason: 'beer' },
      { line: '', reason: 'other' },
    ])).toEqual([
      { reason: 'beer', count: 2, lines: ['LAGER 33CL', 'IPA 50CL'] },
      { reason: 'deposit', count: 1, lines: ['PANT'] },
    ]);
  });
});

describe('receiptErrorKey', () => {
  it('maps server codes to messages', () => {
    expect(receiptErrorKey(422, { code: 'not_a_receipt' }).key).toBe('importBottles.receipt.errors.notReceipt');
    expect(receiptErrorKey(429, { code: 'ai_budget_exhausted' }).key).toBe('importBottles.receipt.errors.budget');
    expect(receiptErrorKey(429, {}).key).toBe('importBottles.receipt.errors.tooMany');
    expect(receiptErrorKey(503, { code: 'ai_unavailable' }).key).toBe('importBottles.receipt.errors.unavailable');
  });

  it('passes a 400 reason through and falls back to a generic message', () => {
    expect(receiptErrorKey(400, { error: 'The PDF is too large (max 10 MB).' }))
      .toEqual({ key: 'importBottles.receipt.errors.withReason', values: { reason: 'The PDF is too large (max 10 MB).' } });
    expect(receiptErrorKey(500).key).toBe('importBottles.receipt.errors.generic');
  });
});
