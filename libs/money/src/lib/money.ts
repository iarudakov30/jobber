/**
 * Money is a `bigint` count of an asset's minor units (cents for USD) everywhere inside the
 * code, and a decimal string of minor units on the wire (GraphQL, gRPC, JSON, outbox payloads).
 * Nothing here goes through a JS `number`, so no amount is ever rounded.
 */
export const ASSETS = {
  USD: { scale: 2 },
} as const; // coins arrive in phase 4

export type AssetCode = keyof typeof ASSETS;

/** Largest amount a PostgreSQL `bigint` (and a protobuf `int64`) can hold. */
export const MAX_MINOR_UNITS = 2n ** 63n - 1n;
const MIN_MINOR_UNITS = -(2n ** 63n);

export class MoneyFormatError extends Error {
  override readonly name = 'MoneyFormatError';
}

export function isAssetCode(value: string): value is AssetCode {
  return Object.prototype.hasOwnProperty.call(ASSETS, value);
}

/** Digits after the decimal point: 2 for USD. */
export function scaleOf(asset: AssetCode): number {
  const info = ASSETS[asset];
  if (!info) {
    throw new MoneyFormatError(`Unknown asset ${asset}`);
  }
  return info.scale;
}

/**
 * Parses an amount typed by a person, in major units: "12.34" → 1234n for USD.
 *
 * Accepts an optional leading minus and at most `scale` decimals ("12", "12.3", "0.05").
 * Rejects anything it would have to round ("1.234" for USD), thousands separators, exponents,
 * and amounts out of `bigint` range.
 */
export function parseAmount(input: string, asset: AssetCode): bigint {
  const scale = scaleOf(asset);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new MoneyFormatError(`"${input}" is not an amount`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > scale) {
    throw new MoneyFormatError(
      `${asset} has ${scale} decimal places; "${input}" has ${fraction.length}`,
    );
  }
  const digits = whole + fraction.padEnd(scale, '0');
  const minor = BigInt(digits) * (sign ? -1n : 1n);
  return inRange(minor, input);
}

/**
 * Formats minor units for display: 123456n USD → "$1,234.56" (en-US).
 *
 * The amount reaches `Intl.NumberFormat` as a decimal string, which it formats exactly, so
 * amounts above `Number.MAX_SAFE_INTEGER` keep every digit.
 */
export function formatAmount(
  minor: bigint,
  asset: AssetCode,
  locale = 'en-US',
): string {
  const scale = scaleOf(asset);
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: asset,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
  // `format(string)` (Intl.NumberFormat v3) is typed only in TypeScript's ES2023 lib.
  return (formatter as unknown as { format(value: string): string }).format(
    toDecimal(minor, scale),
  );
}

/** Minor units as a plain decimal in major units, with no grouping: 123456n, 2 → "1234.56". */
export function toDecimal(minor: bigint, scale: number): string {
  const sign = minor < 0n ? '-' : '';
  const digits = (minor < 0n ? -minor : minor)
    .toString()
    .padStart(scale + 1, '0');
  if (scale === 0) {
    return sign + digits;
  }
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Minor units → wire format: 1250n → "1250". */
export function toWire(minor: bigint): string {
  return inRange(minor, minor.toString()).toString();
}

/**
 * Wire format → minor units: "1250" → 1250n. Accepts only the canonical form `toWire` produces
 * (no sign but "-", no leading zeros, no "-0", no whitespace), so one amount has one spelling.
 */
export function fromWire(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value)) {
    throw new MoneyFormatError(`"${value}" is not an amount in minor units`);
  }
  return inRange(BigInt(value), value);
}

function inRange(minor: bigint, input: string): bigint {
  if (minor > MAX_MINOR_UNITS || minor < MIN_MINOR_UNITS) {
    throw new MoneyFormatError(`"${input}" is out of range`);
  }
  return minor;
}
