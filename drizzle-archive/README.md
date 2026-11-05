# Historical migration archive

This is the preserved pre-Neon migration chain, including its original metadata.
It depends on the former external auth schema and must never initialize or update
a Neuton-owned-auth database. The active runner and Drizzle configuration discover
only `drizzle-neon/`.

The recipe and receipt regression tests read three archived migrations into
connection-local temporary tables. They do not replay this chain against public
application tables. Preserve these files unchanged as historical evidence.

Use the fresh baseline and guarded migration process described in
[the setup guide](../docs/auth-setup.md). Do not copy historical ledger entries,
users, sessions, or business data into a fresh environment.
