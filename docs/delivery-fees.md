# Shop default delivery fee

`deliveryBaseFee` is the store default used to prefill later New Order drafts.
It is not a minimum fee. Existing stored defaults retain their values, including
an explicit zero. New shop creation keeps its existing default of 3.

`GET /api/v1/shop/delivery-preview` returns that default, rounded with the existing
money policy. The deprecated `distanceKm` query remains accepted for old callers
and defaults to zero when omitted. Negative/nonfinite distances and unknown query
keys still fail validation. Distance does not change the fee.

The compatibility response retains `distanceKm` and `baseFee`; `ratePerKm` is zero
and `deliveryFee` equals the default. Stored legacy rate fields remain readable and
are not multiplied into the preview. Existing owner/admin settings permissions and
member read permissions are unchanged.

This is T03 of [New Order #268](https://github.com/Neuton-AI/Neuton-Back/issues/268).
Per-order final-fee input and order quote/create migration are T06. The
[New Order API rollout](new-order-api-rollout.md) records the cached-client
compatibility window. Existing distance/rate columns and historical
financial snapshots are retained.

Reverting this provider restores the previous preview calculation; no migration
or data rewrite needs reversing. Coordinate rollback with settings and order
callers after they adopt the default-fee contract.
