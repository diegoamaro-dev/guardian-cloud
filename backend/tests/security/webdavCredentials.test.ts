import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptWebdavPassword,
  decryptWebdavPassword,
} from '../../src/security/webdavCredentials.js';

// 32 zero bytes encoded as base64 — valid key for tests
const VALID_KEY = Buffer.alloc(32).toString('base64');

describe('webdavCredentials', () => {
  beforeEach(() => {
    process.env.WEBDAV_ENCRYPTION_KEY = VALID_KEY;
  });

  afterEach(() => {
    delete process.env.WEBDAV_ENCRYPTION_KEY;
  });

  it('encrypt then decrypt returns original password', () => {
    const original = 'super-secret-nas-password!@#';
    const encrypted = encryptWebdavPassword(original);
    expect(decryptWebdavPassword(encrypted)).toBe(original);
  });

  it('same input produces different encrypted outputs (random IV)', () => {
    const password = 'same-password';
    const enc1 = encryptWebdavPassword(password);
    const enc2 = encryptWebdavPassword(password);
    expect(enc1).not.toBe(enc2);
  });

  it('invalid payload format throws', () => {
    expect(() => decryptWebdavPassword('notvalid')).toThrow();
    expect(() => decryptWebdavPassword('v1:a:b')).toThrow(); // 3 parts
    expect(() => decryptWebdavPassword('v2:a:b:c')).toThrow(); // wrong version
  });

  it('missing WEBDAV_ENCRYPTION_KEY throws', () => {
    delete process.env.WEBDAV_ENCRYPTION_KEY;
    expect(() => encryptWebdavPassword('test')).toThrow('WEBDAV_ENCRYPTION_KEY is not set');
  });

  it('key that decodes to wrong length throws', () => {
    // 16 bytes → not 32
    process.env.WEBDAV_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(() => encryptWebdavPassword('test')).toThrow(
      'WEBDAV_ENCRYPTION_KEY must decode to exactly 32 bytes',
    );
  });
});
