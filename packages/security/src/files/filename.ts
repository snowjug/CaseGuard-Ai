import { stripHiddenCharacters } from '../injection/hidden';

export type UploadIssueCode =
  | 'filename_empty'
  | 'filename_too_long'
  | 'filename_path_separator'
  | 'filename_path_traversal'
  | 'filename_control_characters'
  | 'filename_invalid_characters'
  | 'filename_reserved_name'
  | 'filename_trailing_dot_or_space'
  | 'filename_hidden_file'
  | 'filename_double_extension'
  | 'extension_not_allowed'
  | 'media_type_malformed'
  | 'media_type_not_allowed'
  | 'media_type_mismatch'
  | 'charset_not_supported'
  | 'empty_file'
  | 'file_too_large'
  | 'binary_content'
  | 'executable_or_archive_signature'
  | 'unsupported_encoding'
  | 'invalid_utf8'
  | 'active_content'
  | 'invalid_json'
  | 'json_too_deep';

export interface UploadIssue {
  readonly code: UploadIssueCode;
  readonly message: string;
}

export const MAX_FILE_NAME_LENGTH = 120;

/** Extensions that can execute, script or unpack: never acceptable as an inner "extension". */
const RISKY_EXTENSIONS = new Set(
  (
    'exe dll bat cmd com scr pif ps1 psm1 vbs vbe js jse wsf wsh msi msp jar sh bash py rb pl php asp ' +
    'aspx jsp cgi html htm svg hta lnk reg iso img zip rar 7z gz tar pdf doc docm docx xls xlsm xlsx ' +
    'ppt pptm app apk deb rpm dmg so dylib sys ocx cpl jnlp chm'
  ).split(' '),
);

/** Windows device names are reserved with or without an extension. */
const RESERVED_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_EXTENSION_LENGTH = 10;

export interface FileNameCheck {
  readonly issues: UploadIssue[];
  /** ASCII-only, single-dot, at most 120 characters, never a path or device name. */
  readonly safeFileName: string;
  /** Lower-case extension without the dot of the *client-supplied* name, or '' if none. */
  readonly extension: string;
}

function isControlOrInvisible(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xe0000 && code <= 0xe007f)
  );
}

/** Applies every filename hygiene rule and derives a storage-safe name; never throws. */
export function checkFileName(rawName: unknown): FileNameCheck {
  const name = typeof rawName === 'string' ? rawName : '';
  const issues: UploadIssue[] = [];
  const add = (code: UploadIssueCode, message: string): void => {
    issues.push({ code, message });
  };

  if (name.trim().length === 0) add('filename_empty', 'The file has no name');
  if (name.length > MAX_FILE_NAME_LENGTH) {
    add('filename_too_long', `The file name is longer than ${MAX_FILE_NAME_LENGTH} characters`);
  }
  if (/[\\/]/.test(name)) add('filename_path_separator', 'The file name contains a path separator');
  if (name.includes('..') || /%2e%2e|%2f|%5c|%00/i.test(name)) {
    add('filename_path_traversal', 'The file name contains a path-traversal sequence');
  }
  if ([...name].some((char) => isControlOrInvisible(char.codePointAt(0) ?? 0))) {
    add(
      'filename_control_characters',
      'The file name contains control, invisible or bidirectional characters',
    );
  }
  if (/[<>:"|?*]/.test(name)) {
    add('filename_invalid_characters', 'The file name contains characters that are not allowed');
  }
  if (/[. ]$/.test(name)) {
    add('filename_trailing_dot_or_space', 'The file name ends with a dot or a space');
  }

  // Work on the last path segment only, as every browser and OS does when saving.
  const segment = name.split(/[\\/]/).pop() ?? '';
  const trimmed = segment.replace(/[. ]+$/, '');
  if (trimmed.startsWith('.'))
    add('filename_hidden_file', 'Hidden files (leading dot) are not accepted');

  const parts = trimmed.split('.');
  const extension = parts.length > 1 ? (parts[parts.length - 1] ?? '').toLowerCase() : '';
  const inner = parts.slice(1, -1).map((part) => part.toLowerCase());
  if (inner.some((part) => RISKY_EXTENSIONS.has(part))) {
    add('filename_double_extension', 'The file name hides an executable or archive extension');
  }
  const baseName = (parts[0] ?? '').toLowerCase();
  const reservedStem = RESERVED_DEVICE_NAMES.test(baseName.trim());
  if (reservedStem) add('filename_reserved_name', 'The file name is a reserved system name');

  return { issues, safeFileName: deriveSafeFileName(segment, reservedStem), extension };
}

function deriveSafeFileName(segment: string, reservedStem: boolean): string {
  // NFKD splits "é" into "e" + a combining accent, so dropping the accents keeps names readable.
  const cleaned = stripHiddenCharacters(segment.normalize('NFKD'))
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.');

  const lastDot = cleaned.lastIndexOf('.');
  // One dot only: an inner ".exe" must not survive as something a downstream system might act on.
  let stem = (lastDot >= 0 ? cleaned.slice(0, lastDot) : cleaned)
    .replace(/\./g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  const extension = (lastDot >= 0 ? cleaned.slice(lastDot + 1) : '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, MAX_EXTENSION_LENGTH);

  if (stem.length === 0) stem = 'upload';
  if (reservedStem || RESERVED_DEVICE_NAMES.test(stem)) stem = `_${stem}`;
  const budget = MAX_FILE_NAME_LENGTH - (extension.length > 0 ? extension.length + 1 : 0);
  return `${stem.slice(0, Math.max(1, budget))}${extension.length > 0 ? `.${extension}` : ''}`;
}
