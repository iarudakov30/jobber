const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * An exchange's decimal price ("60510.855", or the number 60510.855) in whole USD cents,
 * rounded half up, without going through floating point: "0.005" is 1 cent, not 0.
 * Throws on anything that isn't a plain non-negative decimal.
 */
export function centsOf(value: string | number): bigint {
  const text = typeof value === 'number' ? String(value) : value;
  const match = DECIMAL.exec(text);
  if (!match) {
    throw new Error(`not a decimal price: ${JSON.stringify(value)}`);
  }
  const [, whole, fraction = ''] = match;
  const cents =
    BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return fraction.length > 2 && fraction[2] >= '5' ? cents + 1n : cents;
}

/**
 * A price for the live stream: USD cents as a float, not rounded (the published tick is). Returns
 * null for anything that isn't a positive decimal.
 */
export function floatCentsOf(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const match = DECIMAL.exec(String(value));
  if (!match) {
    return null;
  }
  // Move the decimal point in the text, not by × 100: 35.12 × 100 is 3511.9999999999995.
  const [, whole, fraction = ''] = match;
  const padded = fraction.padEnd(2, '0');
  const cents = Number(
    `${whole}${padded.slice(0, 2)}.${padded.slice(2) || '0'}`,
  );
  return cents > 0 && Number.isFinite(cents) ? cents : null;
}
