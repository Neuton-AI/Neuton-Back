import type { PriceResult } from '../../src/lib/supermarket/product-search.js';

export function priceResult(overrides: Partial<PriceResult> = {}): PriceResult {
  return {
    priceUpdateTime: '', itemCode: '123', lastSaleDateTime: '', itemType: '',
    itemName: 'Milk', manufactureName: '', manufactureCountry: '',
    manufactureItemDescription: '', unitQty: '', quantity: '', unitOfMeasure: '',
    bIsWeighted: '', qtyInPackage: '', itemPrice: '6', unitOfMeasurePrice: '',
    allowDiscount: '', itemStatus: '', chainId: 'shufersal', score: 5000,
    ...overrides,
  };
}
