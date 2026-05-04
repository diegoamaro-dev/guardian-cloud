-- Guardian Cloud — 0004 destinations: NAS (WebDAV) prep
--
-- Phase 0 of NAS support. PURELY ADDITIVE:
--   - extend the `type` CHECK to allow 'nas' alongside 'drive'
--   - add 4 nullable columns for WebDAV configuration
--   - add a CHECK that NAS rows MUST use https:// URLs
--
-- Existing Drive rows are not touched. The runtime behavior of the
-- backend does NOT change with this migration alone — no endpoint
-- or adapter is wired here. NAS uploads remain unimplemented.

-- Replace the type CHECK to allow 'nas'.
-- The constraint name follows PostgreSQL's auto-generated convention
-- from migration 0003 (`destinations_type_check`). The DROP IF EXISTS
-- keeps this idempotent for environments that diverged.
ALTER TABLE destinations
  DROP CONSTRAINT IF EXISTS destinations_type_check;

ALTER TABLE destinations
  ADD CONSTRAINT destinations_type_check
  CHECK (type IN ('drive', 'nas'));

-- WebDAV configuration columns. ALL nullable so every existing Drive
-- row remains valid without any data migration. Drive rows leave
-- these columns NULL forever; NAS rows populate them.
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS webdav_url                text,
  ADD COLUMN IF NOT EXISTS webdav_username           text,
  ADD COLUMN IF NOT EXISTS webdav_password_encrypted text,
  ADD COLUMN IF NOT EXISTS webdav_base_path          text;

-- HTTPS-only enforcement for NAS rows. Plain HTTP and self-signed
-- TLS are intentionally rejected at the schema level so a buggy
-- service-role write cannot accidentally persist an insecure NAS
-- endpoint. Drive rows are exempt — `type <> 'nas'` short-circuits.
ALTER TABLE destinations
  ADD CONSTRAINT destinations_nas_requires_https
  CHECK (
    type <> 'nas'
    OR (webdav_url IS NOT NULL AND webdav_url LIKE 'https://%')
  );
