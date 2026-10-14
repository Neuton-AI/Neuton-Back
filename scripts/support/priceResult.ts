import type { PriceResult } from '../../src/lib/supermarket/prices.js';

export function priceResult(overrides: Partial<PriceResult> = {}): PriceResult {
  return {
    PriceUpdateTime: '', ItemCode: '123', LastSaleDateTime: '', ItemType: '',
    ItemName: 'Milk', ManufactureName: '', ManufactureCountry: '',
    ManufactureItemDescription: '', UnitQty: '', Quantity: '', UnitOfMeasure: '',
    bIsWeighted: '', QtyInPackage: '', ItemPrice: '6', UnitOfMeasurePrice: '',
    AllowDiscount: '', ItemStatus: '', chain: 'shufersal', score: 5000,
    ...overrides,
  };
}
