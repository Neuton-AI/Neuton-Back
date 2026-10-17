import { sql } from 'drizzle-orm';
import { generalPrices, inventoryItems, recipeIngredients } from '../db/schema/index.js';

/** A price link alone does not establish a valid conversion. */
export const recipeIngredientUnitCost = sql<string | null>`case
  when ${recipeIngredients.baseUnitAmount} > 0 then case
    when ${recipeIngredients.inventoryItemId} is not null
      and ${recipeIngredients.baseUnit} = ${inventoryItems.baseUnit}
      then ${inventoryItems.baseUnitAverageCost}
    when ${recipeIngredients.inventoryItemId} is null
      and ${recipeIngredients.baseUnit} = ${generalPrices.baseUnit}
      and ${generalPrices.baseUnitAmount} > 0
      then ${generalPrices.baseUnitCost}
  end
end`;
