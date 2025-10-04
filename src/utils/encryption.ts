import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // For AES, this is always 16

let ENCRYPTION_KEY: string | undefined = process.env.STREAMBY_ENCRYPTION_KEY;

export const setEncryptionKey = (key: string) => {
  ENCRYPTION_KEY = key;
};

export const encrypt = (text: string): string => {
  if (!ENCRYPTION_KEY) {
    throw new Error('Encryption key is not set. Cannot encrypt credentials.');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
};

export const decrypt = (text: string): string => {
  if (!ENCRYPTION_KEY) {
    throw new Error('Encryption key is not set. Cannot decrypt credentials.');
  }
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift()!, 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
};

export const isEncryptionKeySet = (): boolean => {
  return !!ENCRYPTION_KEY;
};
