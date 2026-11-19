# Order delivery fees

Quote and create use the supplied `deliveryFee`, including zero or values below the shop default. Legacy requests omitting it use `deliveryBaseFee`. Fee inputs accept finite nonnegative numbers or decimal strings with at most two fractional digits, up to 99,999,999.99 (the existing numeric(10,2) range).

Distance never influences newly computed fees. The temporary quote compatibility fields report ratePerKm=0; new orders store neutral deliveryDistanceKm=0. Historical stored fees and distances are unchanged. Delivery remains excluded from net profit. Legacy endpoint/field retirement belongs to T17.

Create validates its inputs and then runs [atomic source review](order-review.md). Coordinate the frontend workflow, partial-profit accounting and shop-preview rollout before production deployment.

Create requires trimmed nonblank `customerName` (up to 160 characters) and `destinationAddress` (up to 300). Historical nullable read DTOs are unchanged. Date omission still means unknown for legacy clients; the new form supplies the date.

Requests contain at most 100 lines. Each optional `expectedUnitPrice` is a bounded, exactly two-decimal string, distinct from the deprecated override `unitPrice`; combining them is rejected. `confirmedUnavailableRecipeIds` is an optional bounded array of unique UUIDs, all present among submitted recipe IDs. Neither field grants authority to alter server prices or skip arbitrary lines. Server review classifies current availability, verifies exact exclusion consent and compares expected prices within the same transaction that persists the order. Unavailable or restored selections and changed prices require renewed review.
