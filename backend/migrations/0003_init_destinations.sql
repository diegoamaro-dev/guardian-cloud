-- Guardian Cloud — 0003 init destinations
-- Creates the `destinations` table. Stores the per-user connection to an
-- external storage target (Phase 1: Google Drive only). The binary evidence
-- itself is NEVER stored in our DB — this table only records:
--   - which provider is linked
--   - the OAuth refresh_token needed to mint short-lived access_tokens
--   - the pre-created root folder in the user's Drive (/GuardianCloud)
--   - the email the user authorised, for display only
--
-- MVP rules (kept tight on purpose):
--   - one destination per (user_id, type). If the user re-connects the
--     same type, we UPDATE the row instead of inserting a duplicate.
--   - RLS is enabled with no policies. All access goes through the backend
--     using the service role, same pattern as `sessions` and `chunks`.
--   - `status` is kept as a plain text enum-ish string so additional states
--     ('revoked', 'error') can be added later without a migration.

CREATE TABLE destinations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('drive')),
  status          text NOT NULL DEFAULT 'connected'
                  CHECK (status IN ('connected', 'revoked', 'error')),

  -- OAuth refresh token. Service-role-only access; mobile never sees it.
  -- Nullable because `POST /destinations` (generic) may save a row before
  -- an OAuth dance completes.
  refresh_token   text,

  -- Root folder (`/GuardianCloud`) pre-created in the user's Drive at
  -- connect time so every later upload just appends children to it.
  folder_id       text,

  -- Google account email used at connect time, for UI display only.
  account_email   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- "One Drive per user" MVP constraint.
  CONSTRAINT uniq_user_destination UNIQUE (user_id, type)
);

CREATE INDEX idx_destinations_user
  ON destinations (user_id);

CREATE TRIGGER trg_destinations_updated_at
  BEFORE UPDATE ON destinations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Defense-in-depth: enable RLS with no policies so the anon key cannot
-- read or write. Backend uses the service role key and bypasses RLS.
ALTER TABLE destinations ENABLE ROW LEVEL SECURITY;
