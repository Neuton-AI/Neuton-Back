# Changelog

## Unreleased

### Added
- Orders record a requested delivery date and line costing completeness without inventing historical values.
- Recipe list, detail and sync downloads expose complete or partial order pricing,
  including known production cost and costing completeness.

### Fixed
- Recipes with invalid yield report a pricing-data error without manufacturing a
  price or preventing other catalog recipes from loading.
