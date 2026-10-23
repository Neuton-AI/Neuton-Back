import {domainHarness} from './domainApp.js';
import type {searchProduct} from '../../src/lib/supermarket/prices.js';
export {SHOP_ID,USER_ID,TEST_SHOP} from './domainApp.js';
export const NOW=new Date('2026-06-15T12:34:56Z');
export function buildOrdersApp(role='owner'){return domainHarness(role);}
