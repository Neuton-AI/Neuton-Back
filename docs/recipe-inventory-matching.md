# Recipe inventory matching (#151)

During extraction, both worker save paths read inventory once, restricted to the
current shop. They match each ingredient independently in this order:

1. Ingredient `rawMaterialName` against inventory `rawMaterialName`.
2. If absent, ingredient `rawName` against inventory `name`.
3. Otherwise persist a null inventory link for supermarket fallback.

Both comparisons trim edges, collapse whitespace and lowercase. Empty names
never match; there is no substring, punctuation stripping or fuzzy matching.
When several candidates share a normalized name, the lexicographically lowest
UUID wins. This deliberately stable rule applies to both lookup stages; a
display-name match does not override an existing material-name candidate.

Links are saved while the recipe is unverified. Matching neither creates
inventory nor changes stock. Existing inventory links bypass supermarket search.
Receipt lookup behavior is unchanged. Base-unit costing remains the separate
phase 5 work in #153; this matcher does not select or calculate costs.

## Repeated lines and deployment (#97)

Apply migration `0026_recipe_repeated_lines.sql` before deploying the worker.
It removes uniqueness on recipe/inventory and recipe/raw-name pairs, replacing
their recipe lookup coverage with a non-unique recipe index. Ingredient UUIDs
remain unique and existing rows are preserved. Every extracted line retains its
own link, name, quantity and unit, including repeated raw names and mixed units.
This avoids guessing conversions or dropping links/quantities to satisfy the
old indexes. Verification already persists lines independently and needs no
additional merging behavior.

Rolling back the application is possible, but recreating the old unique indexes
after repeated lines have been saved requires a deliberate data reconciliation.
Do not delete duplicate lines to force a schema rollback.

## Verification

`scripts/recipe-inventory.test.ts` covers normalized exact matching, precedence,
fallback, duplicate candidate ordering, empty names and shop-scoped SQL. Its
optional `RECIPE_CONTRACT_TEST_DATABASE_URL` test checks the forward migration
against temporary tables, including repeated linked and unlinked lines.
Worker tests exercise both save paths, preserved amounts, pre-verification
links, no inventory writes and skipped searches for linked ingredients.
