# Changelog

## Unreleased
- Partial-cost sales retain revenue and known costs while contributing zero profit across saved-order reads and reporting; partial-order profit is frozen without rewriting financial history.

### Added
- Order creation checks selected availability and reviewed prices atomically before allocating an invoice.
- Orders record a requested delivery date and line costing completeness without inventing historical values.
- Recipe list, detail and sync downloads expose complete or partial order pricing,
  including known production cost and costing completeness.

### Changed
- New order input requires a customer and address and validates bounded expected prices and confirmed exclusions.
- Order quotes and creation use the final delivery fee or shop default, without distance rates.

### Fixed
- Recipes with invalid yield report a pricing-data error without manufacturing a
  price or preventing other catalog recipes from loading.
