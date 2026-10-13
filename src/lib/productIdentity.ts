/** A global GTIN needs a standard length and check digit. Other codes require a retailer. */
export function isGlobalProductCode(code: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (sum + check) % 10 === 0;
}

export function productMeasurementKey(code: string | null, chain?: string | null): string | null {
  if (!code) return null;
  if (isGlobalProductCode(code)) return 'barcode:' + code;
  return chain ? chain + ':' + code : null;
}

export function offerMeasurementKey(offer: { barcode: string | null; chain: string; offerKey: string }): string {
  return productMeasurementKey(offer.barcode, offer.chain) ?? 'offer:' + offer.offerKey;
}
