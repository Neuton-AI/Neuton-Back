# Changelog

## Unreleased
- Partial-cost sales retain revenue and known costs while contributing zero profit across saved-order reads and reporting; partial-order profit is frozen without rewriting financial history.

### Added
- Order creation checks selected availability and reviewed prices atomically before allocating an invoice.
- Orders record a requested delivery date and line costing completeness without inventing historical values.
- Existing local recipe snapshots refresh through normal sync when order-pricing
  projections roll out; pricing dependency changes retain existing sync behavior.
- Recipe list, detail and sync downloads expose complete or partial order pricing,
  including known production cost and costing completeness.

### Changed
- New order input requires a customer and address and validates bounded expected prices and confirmed exclusions.
- Reviewed orders require a delivery date. Older clients can still omit the date.
- Order creation uses the final delivery fee or shop default, without distance rates.

### Fixed
- Order creation rejects delivery dates before the order date in the shop's timezone.
- Recipes with invalid yield report a pricing-data error without manufacturing a
  price or preventing other catalog recipes from loading.

### Removed
- Retire the legacy recipe picker, order quote and delivery preview endpoints. New Order uses synced recipes, local totals and the shop's fixed delivery fee.
- Ignore the old distance and per-kilometre rate write fields. Saved delivery values remain available on reads.
