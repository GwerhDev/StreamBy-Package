// A file's content hash: its sha256, as whoever uploads it declares it. StreamBy never reads the
// file to hash it; the storage checks the bytes it receives against the declared hash (see
// S3Adapter.getPresignedUploadUrl) and keeps it, so what's catalogued is what was uploaded.

const HEX = /^[0-9a-f]{64}$/i;
const BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/** A sha256 given as hex (64 characters) or base64 (44), as lowercase hex; null if it isn't one. */
export function parseSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (HEX.test(trimmed)) return trimmed.toLowerCase();
  if (BASE64.test(trimmed)) return Buffer.from(trimmed, 'base64').toString('hex');
  return null;
}

export const sha256Base64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/** Subresource Integrity (the `integrity` attribute of a script, link or fetch). */
export const integrityOf = (hex: string) => `sha256-${sha256Base64(hex)}`;

/** What the upload has to be sent with for the storage to check it against its declared hash. */
export const checksumHeaders = (hex: string): Record<string, string> => ({ 'x-amz-checksum-sha256': sha256Base64(hex) });

/**
 * The sha256 query param of an upload URL request: absent (undefined), or what it declares
 * (hex), or false when it isn't a sha256.
 */
export function declaredSha256(value: unknown): string | undefined | false {
  if (value === undefined || value === '') return undefined;
  return parseSha256(value) ?? false;
}
