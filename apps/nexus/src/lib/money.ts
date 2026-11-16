import { type AssetCode, formatAmount, fromWire } from '@jobber/money';

/** A MinorUnits string from the API ("1250") as display text ("$12.50"). */
export function formatMinorUnits(wire: string, asset: string): string {
  return formatAmount(fromWire(wire), asset as AssetCode);
}
