import {
  ASSETS,
  AssetCode,
  MAX_MINOR_UNITS,
  MoneyFormatError,
  formatAmount,
  fromWire,
  isAssetCode,
  parseAmount,
  toDecimal,
  toWire,
} from './money';

const assets = Object.keys(ASSETS) as AssetCode[];

describe('parseAmount', () => {
  it.each([
    ['12.34', 1234n],
    ['12.3', 1230n],
    ['12', 1200n],
    ['0.05', 5n],
    ['0', 0n],
    ['0.00', 0n],
    ['-12.34', -1234n],
    ['-0.01', -1n],
    ['007.50', 750n],
    [' 1.25 ', 125n],
    // Past Number.MAX_SAFE_INTEGER: a float would have rounded the last digits away.
    ['90071992547409.93', 9007199254740993n],
    ['92233720368547758.07', MAX_MINOR_UNITS],
  ])('reads USD "%s" as %p', (input, expected) => {
    expect(parseAmount(input, 'USD')).toBe(expected);
  });

  it.each([
    ['1.234', /2 decimal places/], // never rounds
    ['0.001', /2 decimal places/],
    ['1,000.00', /not an amount/],
    ['1e3', /not an amount/],
    ['12.', /not an amount/],
    ['.5', /not an amount/],
    ['+5', /not an amount/],
    ['--5', /not an amount/],
    ['', /not an amount/],
    ['abc', /not an amount/],
    ['NaN', /not an amount/],
    ['Infinity', /not an amount/],
    ['92233720368547758.08', /out of range/],
  ])('rejects USD "%s"', (input, message) => {
    expect(() => parseAmount(input, 'USD')).toThrow(MoneyFormatError);
    expect(() => parseAmount(input, 'USD')).toThrow(message);
  });

  it('rejects an unknown asset', () => {
    expect(() => parseAmount('1', 'XXX' as AssetCode)).toThrow(/Unknown asset/);
  });
});

describe('formatAmount', () => {
  it.each([
    [123456n, '$1,234.56'],
    [5n, '$0.05'],
    [0n, '$0.00'],
    [-1234n, '-$12.34'],
    [100n, '$1.00'],
    [9007199254740993n, '$90,071,992,547,409.93'],
    [MAX_MINOR_UNITS, '$92,233,720,368,547,758.07'],
  ])('shows %p USD as %s', (minor, expected) => {
    expect(formatAmount(minor, 'USD')).toBe(expected);
  });

  it('follows the locale', () => {
    // de-DE puts the symbol after the number, separated by a no-break space.
    expect(formatAmount(123456n, 'USD', 'de-DE')).toBe('1.234,56 $');
  });
});

describe('toDecimal', () => {
  it.each([
    [123456n, 2, '1234.56'],
    [5n, 2, '0.05'],
    [-5n, 2, '-0.05'],
    [0n, 2, '0.00'],
    [42n, 0, '42'],
    [1n, 8, '0.00000001'],
  ])('writes %p at scale %p as %s', (minor, scale, expected) => {
    expect(toDecimal(minor, scale)).toBe(expected);
  });
});

describe('wire format', () => {
  it.each([
    [0n, '0'],
    [1250n, '1250'],
    [-1250n, '-1250'],
    [MAX_MINOR_UNITS, '9223372036854775807'],
    [-(2n ** 63n), '-9223372036854775808'],
  ])('writes %p as "%s" and reads it back', (minor, wire) => {
    expect(toWire(minor)).toBe(wire);
    expect(fromWire(wire)).toBe(minor);
  });

  it.each([
    '',
    ' 1',
    '1 ',
    '+1',
    '-0',
    '01',
    '1.5',
    '1e3',
    '0x10',
    '9223372036854775808',
  ])('rejects "%s"', (wire) => {
    expect(() => fromWire(wire)).toThrow(MoneyFormatError);
  });

  it('rejects a number passed where a string belongs', () => {
    expect(() => fromWire(1250 as unknown as string)).toThrow(MoneyFormatError);
  });

  it('refuses to write an amount out of range', () => {
    expect(() => toWire(2n ** 63n)).toThrow(/out of range/);
  });
});

describe.each(assets)('round-trips for %s', (asset) => {
  const scale = ASSETS[asset].scale;
  const samples = [0n, 1n, -1n, 10n ** BigInt(scale), 123456789n, -987654321n];

  it.each(samples)(
    '%p survives parse(toDecimal) and fromWire(toWire)',
    (minor) => {
      expect(parseAmount(toDecimal(minor, scale), asset)).toBe(minor);
      expect(fromWire(toWire(minor))).toBe(minor);
    },
  );

  it('is a known asset code', () => {
    expect(isAssetCode(asset)).toBe(true);
    expect(isAssetCode('toString')).toBe(false);
  });
});
