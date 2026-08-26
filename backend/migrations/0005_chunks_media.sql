-- Guardian Cloud — 0005 chunks.media
--
-- G3'' — the medium of a chunk's bytes, as a property of the UNIT OF
-- EVIDENCE rather than of the session.
--
-- Why the session cannot carry it: a Protection Session will eventually
-- hold chunks produced by more than one recorder, so `sessions.mode` —
-- which the client declares once, at creation — can only describe the
-- medium the capture STARTED with. Asking it to describe every chunk
-- would make it lie the moment two producers contribute to one session.
--
-- NULLABLE on purpose. NULL means "medium not declared", never "video":
-- rows written before this column existed, and rows from a client that
-- does not send the field, must never be read as one medium or the
-- other. The v2 manifest writer refuses to build a document from a row
-- whose medium is unknown rather than inferring one.
--
-- NOT VALID skips revalidating existing rows: the constraint applies to
-- every future INSERT/UPDATE, the migration stays instant, and the
-- column can be dropped to roll back.

ALTER TABLE chunks
  ADD COLUMN media text NULL;

ALTER TABLE chunks
  ADD CONSTRAINT chunks_media_valid
  CHECK (media IS NULL OR media IN ('video', 'audio'))
  NOT VALID;

COMMENT ON COLUMN chunks.media IS
  'G3II: medium of THIS chunk''s bytes. NULL = not declared, never video.';
