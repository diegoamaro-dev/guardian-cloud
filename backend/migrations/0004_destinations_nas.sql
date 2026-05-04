ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS webdav_url text,
  ADD COLUMN IF NOT EXISTS webdav_username text,
  ADD COLUMN IF NOT EXISTS webdav_password_encrypted text,
  ADD COLUMN IF NOT EXISTS webdav_base_path text;

ALTER TABLE destinations
  DROP CONSTRAINT IF EXISTS destinations_type_check;

ALTER TABLE destinations
  ADD CONSTRAINT destinations_type_check
  CHECK (type IN ('drive', 'nas'));

ALTER TABLE destinations
  DROP CONSTRAINT IF EXISTS destinations_nas_requires_https;

ALTER TABLE destinations
  ADD CONSTRAINT destinations_nas_requires_https
  CHECK (
    type <> 'nas'
    OR (webdav_url IS NOT NULL AND webdav_url LIKE 'https://%')
  );