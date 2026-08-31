# Changelog

## 0.2.0

Facet-native greenfield architecture.

### Breaking changes

- Kinds run in isolated Durable Object facets. Existing pre-facet 0.1.x
  instances are not upgraded in place.
- Import `DurableObject` from `claydo` for full facet alarm support.
- Root exports `KIND_HEADER`, `KIND_STORAGE_KEY`, and `NO_INIT_HEADER` are
  removed. They were host implementation details.
- Function-valued instance fields are not RPC methods; use prototype methods,
  matching native Workers RPC.
- `deleteAll()` clears facet user storage without changing supervisor kind
  identity. SQLite schemas must be recreated by the method, as with native
  Durable Object storage.

Because claydo had no production adopters, 0.2.0 intentionally provides no
same-binding data adoption path from the unpublished/experimental 0.1 design.

### Added

- Isolated facet SQL/KV for every kind instance.
- Supervisor-backed alarm virtualization.
- Facet-safe storage reset and stable stubs across facet aborts.
- Staged, checkpointed migration imports with verified clone-to-live cutover.
