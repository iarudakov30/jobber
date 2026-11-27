import { centsOf, floatCentsOf } from './cents';

describe('centsOf', () => {
  it.each([
    ['60510.85', 6051085n],
    ['60510.855', 6051086n],
    ['60510.854999', 6051085n],
    ['0.005', 1n],
    ['0.004', 0n],
    ['42', 4200n],
    ['42.1', 4210n],
    [60510.85, 6051085n],
    [0.5, 50n],
  ])('%p is %p cents, rounded half up without floats', (value, cents) => {
    expect(centsOf(value)).toBe(cents);
  });

  it.each(['', '-1', '1e5', '1.', '.5', 'abc', '1,000.00'])(
    'refuses %p',
    (value) => {
      expect(() => centsOf(value)).toThrow('not a decimal price');
    },
  );
});

describe('floatCentsOf', () => {
  it('keeps the fraction of a cent for the tick to round', () => {
    expect(floatCentsOf('60510.855')).toBeCloseTo(6051085.5, 6);
    expect(floatCentsOf(35.1234)).toBeCloseTo(3512.34, 6);
    // Not 3511.9999999999995, as 35.12 * 100 would be.
    expect(floatCentsOf('35.12')).toBe(3512);
    expect(floatCentsOf('3001.5')).toBe(300150);
  });

  it('is null for anything but a positive decimal', () => {
    for (const value of [
      '0',
      '0.00',
      '-3',
      'x',
      null,
      undefined,
      {},
      1e300 * 10,
    ]) {
      expect(floatCentsOf(value)).toBeNull();
    }
  });
});
