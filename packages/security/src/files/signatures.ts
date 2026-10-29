/*
 * Content sniffing for uploads. Uploads are text-only (JSON, text, CSV, Markdown), so anything that
 * announces itself as an executable, archive, document or image is refused regardless of what the
 * file name or Content-Type claims.
 */

interface Signature {
  readonly name: string;
  readonly matches: (bytes: Uint8Array) => boolean;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

function hasControlByte(bytes: Uint8Array, limit: number): boolean {
  for (let i = 0; i < Math.min(bytes.length, limit); i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return true;
  }
  return false;
}

function containsAscii(bytes: Uint8Array, needle: string, window: number): boolean {
  const target = ascii(needle);
  const end = Math.min(bytes.length, window) - target.length;
  for (let i = 0; i <= end; i += 1) {
    if (startsWith(bytes, target, i)) return true;
  }
  return false;
}

const SIGNATURES: readonly Signature[] = [
  // A PDF reader accepts the header anywhere in the first KiB, so polyglots hide it after junk.
  { name: 'PDF document', matches: (b) => containsAscii(b, '%PDF-', 1024) },
  {
    name: 'ZIP archive or Office document',
    matches: (b) =>
      startsWith(b, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(b, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(b, [0x50, 0x4b, 0x07, 0x08]),
  },
  {
    // "MZ" is also how a text file could start, so require control bytes in the DOS header too.
    name: 'Windows executable',
    matches: (b) => startsWith(b, [0x4d, 0x5a]) && hasControlByte(b, 64),
  },
  { name: 'ELF executable', matches: (b) => startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) },
  {
    name: 'Mach-O executable or Java class',
    matches: (b) =>
      startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) ||
      startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
      startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) ||
      startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
      startsWith(b, [0xca, 0xfe, 0xba, 0xbe]),
  },
  { name: 'gzip archive', matches: (b) => startsWith(b, [0x1f, 0x8b]) },
  {
    name: 'bzip2 archive',
    matches: (b) => startsWith(b, ascii('BZh')) && /[1-9]/.test(String.fromCharCode(b[3] ?? 0)),
  },
  { name: 'xz archive', matches: (b) => startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { name: 'zstd archive', matches: (b) => startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]) },
  { name: 'RAR archive', matches: (b) => startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]) },
  { name: '7-Zip archive', matches: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { name: 'tar archive', matches: (b) => startsWith(b, ascii('ustar'), 257) },
  {
    name: 'PNG image',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { name: 'JPEG image', matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    name: 'GIF image',
    matches: (b) => startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a')),
  },
  {
    name: 'RIFF media container',
    matches: (b) =>
      startsWith(b, ascii('RIFF')) &&
      (startsWith(b, ascii('WEBP'), 8) ||
        startsWith(b, ascii('WAVE'), 8) ||
        startsWith(b, ascii('AVI '), 8)),
  },
  { name: 'MP4 media', matches: (b) => startsWith(b, ascii('ftyp'), 4) },
  { name: 'SQLite database', matches: (b) => startsWith(b, [...ascii('SQLite format 3'), 0x00]) },
  {
    name: 'legacy Office (OLE2) document',
    matches: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  },
];

/** Name of the binary format the bytes announce themselves as, or null for plausible text. */
export function detectBinarySignature(bytes: Uint8Array): string | null {
  for (const signature of SIGNATURES) {
    if (signature.matches(bytes)) return signature.name;
  }
  return null;
}

/** True when the bytes cannot be text: any NUL byte, or many stray control bytes in the first 8 KiB. */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  const sample = bytes.subarray(0, 8192);
  let controls = 0;
  for (const byte of sample) {
    // ESC is common in terminal logs, form feed in old text files; everything else below 0x20 is not text.
    if (
      byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0d &&
      byte !== 0x0c &&
      byte !== 0x1b
    ) {
      controls += 1;
    }
  }
  return sample.length > 0 && controls / sample.length >= 0.05;
}

/** UTF-16 byte-order marks: such files are text, but not in an encoding we accept. */
export function hasUtf16ByteOrderMark(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]);
}

/** Strict UTF-8 decoding (invalid sequences throw) with a leading BOM removed. */
export function decodeUploadText(bytes: Uint8Array): string {
  const body = startsWith(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes;
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/** Documents that a browser or a server would treat as markup or script if it were ever served inline. */
export function looksLikeActiveContent(text: string): boolean {
  const head = text.slice(0, 256).trimStart().toLowerCase();
  return ['<!doctype html', '<html', '<script', '<svg', '<iframe', '<?php'].some((marker) =>
    head.startsWith(marker),
  );
}
