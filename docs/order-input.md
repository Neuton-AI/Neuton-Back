# Order delivery fees

Quote and create use the supplied `deliveryFee`, including zero or values below the shop default. Legacy requests omitting it use `deliveryBaseFee`. Fee inputs accept finite nonnegative numbers or decimal strings with at most two fractional digits, up to 99,999,999.99 (the existing numeric(10,2) range).

Distance never influences newly computed fees. The temporary quote compatibility fields report ratePerKm=0; new orders store neutral deliveryDistanceKm=0. Historical stored fees and distances are unchanged. Delivery remains excluded from net profit. Legacy endpoint/field retirement belongs to T17.

This contract slice is stacked on the snapshot provider, and the separate shop-preview change is PR #279. Review-aware creation is not ready to deploy until T07's atomic review enforcement is integrated.
