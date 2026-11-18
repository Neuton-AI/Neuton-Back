# Order delivery fees

Quote and create use the supplied `deliveryFee`, including zero or values below the shop default. Legacy requests omitting it use `deliveryBaseFee`. Fee inputs accept finite nonnegative numbers or decimal strings with at most two fractional digits, up to 99,999,999.99 (the existing numeric(10,2) range).

Distance never influences newly computed fees. The temporary quote compatibility fields report ratePerKm=0; new orders store neutral deliveryDistanceKm=0. Historical stored fees and distances are unchanged. Delivery remains excluded from net profit. Legacy endpoint/field retirement belongs to T17.

This contract slice is stacked on the snapshot provider, and the separate shop-preview change is PR #279. Review-aware creation is not ready to deploy until T07's atomic review enforcement is integrated.

Create requires trimmed nonblank `customerName` (up to 160 characters) and `destinationAddress` (up to 300). Historical nullable read DTOs are unchanged. Date omission still means unknown for legacy clients; the new form supplies the date.

Requests contain at most 100 lines. Each optional `expectedUnitPrice` is a bounded, exactly two-decimal string, distinct from the deprecated override `unitPrice`; combining them is rejected. `confirmedUnavailableRecipeIds` is an optional bounded array of unique UUIDs, all present among submitted recipe IDs. Neither field grants authority to alter server prices or skip arbitrary lines. These are input contracts for T07; this slice does not implement availability classification, exclusion enforcement, price-mismatch conflicts or transactional source reads. Keep this draft change out of a production rollout until T07 is integrated.
