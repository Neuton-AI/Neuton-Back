-- #116: purge HTML payloads that earlier builds persisted verbatim.
--
-- POST /orders and the shop settings endpoints accepted any text, so
-- <script>/<img onerror>/<svg onload> payloads sit in these columns exactly as
-- they were sent. The request schemas now reject angle brackets on write; this
-- migration clears what the old builds already let through, so no render path
-- (present or future) can ever meet them.
--
-- Tag sequences are removed first, so text a tag wrapped survives
-- (`<b>Anna</b>` -> `Anna`), then any stray angle brackets — leaving the
-- columns with the same `<`-free invariant the API enforces. Only the three
-- columns with confirmed payloads are rewritten; other text columns are
-- guarded on write from here on.
UPDATE "orders"
SET "customer_name" = regexp_replace(regexp_replace("customer_name", '<[^>]*>', '', 'g'), '[<>]', '', 'g')
WHERE "customer_name" ~ '[<>]';--> statement-breakpoint
UPDATE "orders"
SET "destination_address" = regexp_replace(regexp_replace("destination_address", '<[^>]*>', '', 'g'), '[<>]', '', 'g')
WHERE "destination_address" ~ '[<>]';--> statement-breakpoint
UPDATE "shops"
SET "store_address" = regexp_replace(regexp_replace("store_address", '<[^>]*>', '', 'g'), '[<>]', '', 'g')
WHERE "store_address" ~ '[<>]';
