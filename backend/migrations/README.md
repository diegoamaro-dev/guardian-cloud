# Migrations

SQL migrations for the Guardian Cloud backend.

## Convention

- Numbered sequentially: `NNNN_description.sql`.
- Applied in ascending order.
- Each migration is idempotent only at the DB-constraint level — do not
  re-run against a populated DB without inspecting.

## How to apply (Phase 1)

Option A — Supabase SQL editor (easiest for bootstrap):
1. Open Supabase dashboard → SQL editor.
2. Paste the contents of `0001_init_sessions.sql`, run.
3. Paste `0002_init_chunks.sql`, run.
4. Paste `0003_init_destinations.sql`, run.

Option B — `psql` against the Supabase connection string:

```bash
psql "$SUPABASE_DB_URL" -f migrations/0001_init_sessions.sql
psql "$SUPABASE_DB_URL" -f migrations/0002_init_chunks.sql
psql "$SUPABASE_DB_URL" -f migrations/0003_init_destinations.sql
```

## After applying

Verify from the dashboard (`Table editor`) that:
- `sessions` has columns `id, user_id, mode, destination_type, status,
  chunk_count, created_at, updated_at, completed_at`.
- `chunks` has columns `id, session_id, chunk_index, hash, size, status,
  remote_reference, created_at, updated_at`.
- `UNIQUE (session_id, chunk_index)` exists on `chunks`.
- `destinations` has columns `id, user_id, type, status, refresh_token,
  folder_id, account_email, created_at, updated_at`.
- `UNIQUE (user_id, type)` exists on `destinations`.
- RLS is enabled on all three tables, with no policies defined.
