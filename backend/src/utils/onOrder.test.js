const { parseExpectedArrival, isArrivalDue, formatArrivalMonth } = require('./onOrder');

describe('parseExpectedArrival', () => {
  test('a month, a day, a timestamp and a Date all land on the 1st of that month, noon UTC', () => {
    for (const v of ['2027-03', '2027-3', '2027-03-28', '2027-03-15T23:00:00Z', new Date('2027-03-10T00:00:00Z')]) {
      expect(parseExpectedArrival(v)).toEqual({ ok: true, value: new Date('2027-03-01T12:00:00Z') });
    }
  });

  test('a timestamp is read as WRITTEN — local midnight on the 1st east of UTC stays that month', () => {
    expect(parseExpectedArrival('2027-03-01T00:00:00+01:00').value).toEqual(new Date('2027-03-01T12:00:00Z'));
    expect(parseExpectedArrival('2027-03-31T23:30:00-05:00').value).toEqual(new Date('2027-03-01T12:00:00Z'));
  });

  test('free text a browser without a month picker lets through is refused, not guessed', () => {
    for (const v of ['3/27', '03/2027', 'March 2027', '2027', '2027-03-01junk']) {
      expect(parseExpectedArrival(v)).toMatchObject({ ok: false, error: expect.stringMatching(/YYYY-MM/) });
    }
  });

  test('empty means "no date"', () => {
    for (const v of [undefined, null, '']) expect(parseExpectedArrival(v)).toEqual({ ok: true, value: null });
  });

  test('refuses a bad month, a year out of range, and non-scalar input', () => {
    expect(parseExpectedArrival('2027-13').ok).toBe(false);
    expect(parseExpectedArrival('1989-05').ok).toBe(false);
    expect(parseExpectedArrival(`${new Date().getUTCFullYear() + 16}-01`).ok).toBe(false);
    expect(parseExpectedArrival('next spring').ok).toBe(false);
    expect(parseExpectedArrival({ $gt: '' }).ok).toBe(false);
    expect(parseExpectedArrival(['2027-03']).ok).toBe(false);
  });
});

describe('isArrivalDue', () => {
  const march = new Date('2027-03-01T12:00:00Z');
  test('due only once the expected month has fully passed', () => {
    expect(isArrivalDue(march, new Date('2027-03-31T23:59:00Z'))).toBe(false);
    expect(isArrivalDue(march, new Date('2027-04-01T00:00:00Z'))).toBe(true);
  });
  test('no date is never due', () => {
    expect(isArrivalDue(null)).toBe(false);
    expect(isArrivalDue(undefined)).toBe(false);
  });
});

test('formatArrivalMonth reads the stored month in UTC', () => {
  expect(formatArrivalMonth(new Date('2027-03-01T12:00:00Z'))).toBe('March 2027');
});
