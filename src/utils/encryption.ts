import * as crypto from 'crypto';

// Stored credentials, encrypted with AES-256-GCM (authenticated: an altered value fails to
// decrypt instead of decrypting to garbage), each value naming the key it was encrypted with:
//
//   v2:<key id>:<iv>:<auth tag>:<ciphertext>      (base64url parts; a 12-byte iv)
//
// A key's id is a fingerprint of it, so rotating is only configuring the new key as the
// current one and the old ones as previous keys: what's stored keeps decrypting, and is
// re-encrypted with the current key (see services/reencryptCredentials).
//
// Values stored before (AES-256-CBC, "<iv hex>:<ciphertext hex>", no key id) still decrypt,
// with the current key or a previous one.

const GCM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;
const LEGACY_CBC = 'aes-256-cbc';
const VERSION = 'v2';

let currentKey: { id: string; key: Buffer } | undefined;
const keysById = new Map<string, Buffer>();

const keyBuffer = (hex: string): Buffer => {
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Invalid encryption key length. Key must be 32 bytes (64 hexadecimal characters).');
  }
  return Buffer.from(hex, 'hex');
};

// A key's id: a fingerprint of it (never the key, nor enough to find it).
const keyIdOf = (key: Buffer): string =>
  crypto.createHash('sha256').update('streamby-encryption-key:').update(key).digest('hex').slice(0, 16);

/** The key credentials are encrypted with, and the previous ones they may still be in. */
export const setEncryptionKey = (key: string, previousKeys: string[] = []) => {
  const current = keyBuffer(key);
  const previous = previousKeys.map(keyBuffer);
  keysById.clear();
  for (const k of [...previous, current]) keysById.set(keyIdOf(k), k);
  currentKey = { id: keyIdOf(current), key: current };
};

const requireKey = () => {
  if (!currentKey) throw new Error('Encryption key is not set. Cannot encrypt or decrypt credentials.');
  return currentKey;
};

export const encrypt = (text: string): string => {
  const { id, key } = requireKey();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, id, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
};

const decryptLegacy = (text: string, key: Buffer): string => {
  const [ivHex, ...rest] = text.split(':');
  const decipher = crypto.createDecipheriv(LEGACY_CBC, key, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(rest.join(':'), 'hex')), decipher.final()]).toString();
};

export const decrypt = (text: string): string => {
  requireKey();
  if (text.startsWith(`${VERSION}:`)) {
    const [, id, iv, tag, encrypted] = text.split(':');
    const key = keysById.get(id);
    if (!key) throw new Error('This credential was encrypted with a key that is not configured.');
    const decipher = crypto.createDecipheriv(GCM, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('This credential could not be decrypted: it was altered or damaged.');
    }
  }
  // Stored before: CBC, with whichever configured key it was encrypted with.
  let lastError: unknown;
  for (const key of [currentKey!.key, ...[...keysById.values()].filter(k => k !== currentKey!.key)]) {
    try {
      return decryptLegacy(text, key);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('This credential could not be decrypted.');
};

/** Whether a stored value is encrypted the current way (GCM, with the current key). */
export const isCurrentEncryption = (text: string): boolean =>
  !!currentKey && text.startsWith(`${VERSION}:${currentKey.id}:`);

/** Whether a stored value is in this module's own format (GCM, any key). */
export const isVersionedEncryption = (text: string): boolean => text.startsWith(`${VERSION}:`);

export const isEncryptionKeySet = (): boolean => !!currentKey;
