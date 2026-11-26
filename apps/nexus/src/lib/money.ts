import { type AssetCode, formatAmount, fromWire } from '@jobber/money';

/** A MinorUnits string from the API ("1250") as display text ("$12.50"). */
export function formatMinorUnits(wire: string, asset: string): string {
  return formatAmount(fromWire(wire), asset as AssetCode);
}

/** A coin amount without trailing zeros: "10000000" NXC → "0.1 NXC" (whole: "2 NXC"). */
export function formatCoin(wire: string, coin: string): string {
  const full = formatAmount(fromWire(wire), coin as AssetCode);
  return full.replace(/(\.\d*?)0+(?= )/, '$1').replace(/\.(?= )/, '');
}

/** USD cents per coin ("4209") as dollars ("$42.09"). */
export function formatPrice(cents: string): string {
  return formatAmount(fromWire(cents), 'USD');
}
