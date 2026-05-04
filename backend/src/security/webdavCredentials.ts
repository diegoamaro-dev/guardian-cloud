import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const VERSION = 'v1';

function getKey(): Buffer {
  const raw = process.env.WEBDAV_ENCRYPTION_KEY;
  if (!raw) throw new Error('WEBDAV_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('WEBDAV_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

export function encryptWebdavPassword(password: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptWebdavPassword(payload: string): string {
  const key = getKey();
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('Invalid payload format');
  const version = parts[0]!;
  const ivB64 = parts[1]!;
  const authTagB64 = parts[2]!;
  const ciphertextB64 = parts[3]!;
  if (version !== VERSION) throw new Error('Invalid payload format');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
