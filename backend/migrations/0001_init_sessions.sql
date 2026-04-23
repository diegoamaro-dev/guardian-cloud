-- Guardian Cloud — 0001 init sessions
-- Creates the `sessions` table plus the shared `set_updated_at` trigger
-- function that will also serve `chunks` in 0002.

CREATE TYPE session_mode   AS ENUM ('audio', 'video');
CREATE TYPE session_status AS ENUM ('active', 'completed', 'failed');

-- Shared trigger function: keeps `updated_at` honest across tables.
-- Defined once here so later migrations can reuse it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode             session_mode NOT NULL,
  destination_type text NOT NULL,
  status           session_status NOT NULL DEFAULT 'active',
  chunk_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  -- Keep status and completed_at consistent at all times.
  CONSTRAINT chk_completed_at
    CHECK ((status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL))
);

CREATE INDEX idx_sessions_user_created
  ON sessions (user_id, created_at DESC);

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Defense-in-depth: enable RLS with no policies so the anon key cannot
-- read or write. Backend uses the service role key and bypasses RLS.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
