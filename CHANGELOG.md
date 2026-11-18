# Changelog

## Unreleased

### Added
- Existing local recipe snapshots refresh through normal sync when order-pricing
  projections roll out; pricing dependency changes retain existing sync behavior.
- Recipe list, detail and sync downloads expose complete or partial order pricing,
  including known production cost and costing completeness.

### Fixed
- Recipes with invalid yield report a pricing-data error without manufacturing a
  price or preventing other catalog recipes from loading.
