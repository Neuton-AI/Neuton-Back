# Receipt merchant correction API

PATCH /api/v1/receipts/:id accepts exactly `{ "merchantName": "Market" }`.
The authenticated actor must be an owner or admin in the selected shop.

The body requires a trimmed, HTML-free string of 1–200 characters. Unknown fields
are rejected. Success returns HTTP 200 with `{ receipt: ReceiptDto }`; only the
merchant name and update timestamp change. Items, financial amounts, inventory,
and verification state remain unchanged.

The receipt must be unverified or verified. Other lifecycle states return 409;
an unknown or other-shop receipt returns 404, a disallowed role 403, and an
invalid body 400 using the shared error envelope.

The endpoint participates in the existing x-sync-id/x-sync-version protocol,
including replay and conflict handling. Persistence locks the tenant-scoped row
before checking its status and updating it. RECEIPT_UPDATED is audited after
commit without including the merchant name in audit metadata.

This additive API supports Neuton-Front #176. No schema migration is required.
Ship it with the frontend merchant editor. Reverting the frontend first prevents
new correction writes from being queued against a backend without this route.
