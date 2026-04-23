-- Guardian Cloud — 0002 init chunks
-- Creates the `chunks` metadata table. Binary payloads are NOT stored here
-- (Phase 1 contract). `remote_reference` is an opaque pointer to the user's
-- final destination (e.g. Drive file id) and is filled in by the client when
-- the chunk is successfully uploaded to that destination.

CREATE TYPE chunk_status AS ENUM ('pending', 'uploaded', 'failed');

CREATE TABLE chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_index      integer NOT NULL CHECK (chunk_index >= 0),

  -- sha256 hex, lowercase, exactly 64 characters.
  hash             text NOT NULL
                   CHECK (char_length(hash) = 64 AND hash ~ '^[a-f0-9]+$'),

  -- Hard cap matches env.MAX_CHUNK_SIZE_BYTES default (20 MiB).
  size             integer NOT NULL
                   CHECK (size > 0 AND size <= 20971520),

  status           chunk_status NOT NULL,
  remote_reference text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Idempotency boundary. Two writes for the same (session, index) collapse
  -- into a single row at the DB level, independent of application code.
  CONSTRAINT uniq_session_chunk UNIQUE (session_id, chunk_index)
);

CREATE INDEX idx_chunks_session_index
  ON chunks (session_id, chunk_index);

CREATE TRIGGER trg_chunks_updated_at
  BEFORE UPDATE ON chunks
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
