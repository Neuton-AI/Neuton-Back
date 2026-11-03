# Fresh Neon migration chain

Only this directory is active for the Neuton-owned identity database. The explicit runner requires `0000_neuton_baseline.sql`, its own baseline marker and unchanged SHA-256 history. The baseline is assembled in Phase B; until that complete file exists, `db:migrate` refuses before opening a connection. Historical SQL in `drizzle` is not executed by the new runner.

The runner uses MIGRATION_DATABASE_URL only and never loads environment files. Supply it through the shell/deployment environment. Provision restricted roles before the baseline. Initialization refuses existing application relations or a legacy ledger. One transaction-level advisory lock serializes migration batches; DDL, marker and ledger changes commit together. A failed batch rolls back. There is no reset, owner fallback, schema push or manual marking path.
