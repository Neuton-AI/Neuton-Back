# Neuton-Back

## Verification endpoints

All verification actions are domain-specific POST requests under `/api/v1`.

| Endpoint | Request body | Result | Required shop role |
| --- | --- | --- | --- |
| `/receipts/:id/verify` | `{ items: [{ id, accepted, ...corrections }] }` | Receipt becomes `verified`; accepted lines update inventory. Unit corrections use `srcUnit`. | Owner or admin |
| `/recipes/:id/verify` | `{}` or `{ ingredients: [...] }` | Recipe becomes `verified`; supplied ingredients replace the extracted lines in the same transaction. | Owner or admin |
| `/orders/:id/verify` | No body required | Order moves from `processing` to `delivered`. | Any shop member |

The old `POST /catalog/:type/:id/verify` and `PATCH /orders/:id/status` routes
have been removed. Deploy clients using the domain endpoints together with this
server change. Response shapes and verification permissions are unchanged.

Receipt verification copies `rawMaterialName`, `baseUnit`, and `baseUnitAmount`
from each accepted receipt line into its inventory item. Those fields, plus
`baseUnitCost`, can also be supplied as optional line corrections. Base unit
cost defaults to the corrected `unitPrice / baseUnitAmount` and is saved with
six decimal places; an explicit zero amount produces a zero cost. When an older
extraction has no measurements, verification retains the inventory item's
package measurement (one source unit for a new item). Stock quantities and
weighted average purchase costs continue to use the receipt's purchase units.
An extraction that names a different base unit without an amount saves zero
amount and cost until a complete measurement is supplied.

Apply `0023_receipt_item_raw_material_name.sql` before deploying this version.
It backfills existing receipt lines from `raw_name` before making the new
material name required.
