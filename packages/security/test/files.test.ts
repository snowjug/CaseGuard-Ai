import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { sha256Hex } from '../src/hashing';
import { checkFileName, MAX_FILE_NAME_LENGTH } from '../src/files/filename';
import {
  EICAR_TEST_STRING,
  EicarTestScanner,
  NoopMalwareScanner,
  createMalwareScanner,
} from '../src/files/malware';
import {
  validateUpload,
  type UploadCheckResult,
  type UploadIssueCode,
} from '../src/files/validate-upload';

const MAX = 2 * 1024 * 1024;
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const codes = (result: UploadCheckResult): UploadIssueCode[] =>
  result.issues.map((issue) => issue.code);

function check(
  fileName: string,
  body: Uint8Array | string,
  mediaType?: string | null,
  maxBytes = MAX,
): UploadCheckResult {
  return validateUpload({
    fileName,
    mediaType,
    bytes: typeof body === 'string' ? enc(body) : body,
    maxBytes,
  });
}

/** Bytes that start with `head` and are padded with a plausible-looking body. */
const withHead = (head: readonly number[], length = 300): Uint8Array => {
  const bytes = new Uint8Array(length).fill(0x41);
  bytes.set(head);
  return bytes;
};

describe('validateUpload: accepted files [FR-ING-05]', () => {
  it.each([
    [
      'case.json',
      '{"schemaVersion":"caseguard.case-bundle/1","events":[]}',
      'application/json',
      'json',
    ],
    ['notes.txt', 'Customer reported intermittent sign-in failures.\n', 'text/plain', 'text'],
    [
      'trace.LOG',
      '2025-01-31 INFO started\n\u001b[31mERROR\u001b[0m failed\n',
      'text/plain',
      'text',
    ],
    ['README.md', '# Title\n\nSome *markdown*.', 'text/markdown', 'markdown'],
    ['export.csv', 'id,title\n1,"VPN down"\n', 'text/csv', 'csv'],
  ] as const)('accepts %s', (fileName, body, mediaType, kind) => {
    const bytes = enc(body);
    const result = check(fileName, bytes, mediaType);
    expect(result).toEqual({
      ok: true,
      kind,
      safeFileName: fileName,
      issues: [],
      sha256: sha256Hex(bytes),
    });
  });

  it('accepts unspecified and parameterised media types and upper-case extensions', () => {
    for (const mediaType of [
      undefined,
      null,
      '',
      'application/octet-stream',
      'text/plain; charset=utf-8',
      'TEXT/PLAIN;charset="UTF-8"',
      'text/plain ; charset=us-ascii',
    ]) {
      expect(check('a.txt', 'hello', mediaType).ok, String(mediaType)).toBe(true);
    }
    expect(check('A.JSON', '{}', 'application/json').ok).toBe(true);
    expect(check('sheet.csv', 'a,b', 'application/vnd.ms-excel').ok).toBe(true);
    expect(check('notes.md', 'x', 'application/octet-stream').ok).toBe(true);
  });

  it('accepts a UTF-8 byte order mark and hashes the raw bytes including it', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('{"a":1}')]);
    const result = check('bom.json', bytes, 'application/json');
    expect(result.ok).toBe(true);
    expect(result.sha256).toBe(sha256Hex(bytes));
  });

  it('accepts any valid JSON value, non-ASCII text and nesting up to 64 levels', () => {
    expect(check('v.json', '"just a string"').ok).toBe(true);
    expect(check('v.json', '[1,2,3]').ok).toBe(true);
    expect(check('u.txt', 'Привіт 你好 🌍 café').ok).toBe(true);
    expect(check('d.json', `${'['.repeat(64)}${']'.repeat(64)}`).ok).toBe(true);
  });

  it('does not mistake a text file that merely starts with MZ for an executable', () => {
    expect(check('log.txt', 'MZ-2025 ticket log: sign-in failed\n').ok).toBe(true);
  });
});

describe('validateUpload: extension and media type [NFR-SEC-04]', () => {
  it('rejects extensions outside the allowlist', () => {
    for (const name of [
      'a.exe',
      'a.pdf',
      'a.docx',
      'a.zip',
      'a.gz',
      'a.html',
      'a.svg',
      'a.js',
      'a',
      'a.',
      'archive.tar.gz',
      'a.json.exe',
    ]) {
      const result = check(name, 'x');
      expect(result.ok, name).toBe(false);
      expect(codes(result), name).toContain('extension_not_allowed');
      expect(result.kind, name).toBeNull();
    }
  });

  it('rejects disallowed and inconsistent media types', () => {
    expect(codes(check('a.txt', 'x', 'application/x-msdownload'))).toContain(
      'media_type_not_allowed',
    );
    expect(codes(check('a.json', 'x', 'text/html'))).toContain('media_type_not_allowed');
    expect(codes(check('a.txt', 'x', 'application/pdf'))).toContain('media_type_not_allowed');
    expect(codes(check('a.json', '{}', 'text/csv'))).toContain('media_type_mismatch');
    expect(codes(check('a.csv', 'a', 'application/json'))).toContain('media_type_mismatch');
    expect(codes(check('a.md', 'a', 'text/csv'))).toContain('media_type_mismatch');
    expect(codes(check('a.txt', 'a', 'application/json'))).toContain('media_type_mismatch');
  });

  it('rejects malformed media types and unsupported charsets', () => {
    for (const mediaType of [
      'x',
      'text/',
      '/plain',
      'text/plain/extra',
      'text plain',
      'a'.repeat(300),
    ]) {
      expect(codes(check('a.txt', 'x', mediaType)), mediaType).toContain('media_type_malformed');
    }
    for (const mediaType of [
      'text/plain; charset=utf-7',
      'text/plain; charset=iso-8859-1',
      'application/json; charset=utf-16',
    ]) {
      expect(codes(check('a.txt', 'x', mediaType)), mediaType).toContain('charset_not_supported');
    }
  });
});

describe('validateUpload: file name hygiene [NFR-SEC-04]', () => {
  const rejected: [name: string, code: UploadIssueCode][] = [
    ['../../etc/passwd.json', 'filename_path_traversal'],
    ['..\\..\\windows\\system32\\config.json', 'filename_path_separator'],
    ['a/b.json', 'filename_path_separator'],
    ['a\\b.json', 'filename_path_separator'],
    ['..json', 'filename_path_traversal'],
    ['a..json', 'filename_path_traversal'],
    ['%2e%2e%2fsecret.json', 'filename_path_traversal'],
    ['%2E%2E%5Csecret.json', 'filename_path_traversal'],
    ['name%00.json', 'filename_path_traversal'],
    ['data\u0000.json', 'filename_control_characters'],
    ['data\u0007.json', 'filename_control_characters'],
    ['report\u202Egpj.json', 'filename_control_characters'],
    ['re\u200Bport.json', 'filename_control_characters'],
    ['a\nb.json', 'filename_control_characters'],
    ['a.json:evil.exe', 'filename_invalid_characters'],
    ['a<b>.json', 'filename_invalid_characters'],
    ['a|b.json', 'filename_invalid_characters'],
    ['a?b.json', 'filename_invalid_characters'],
    ['a*b.json', 'filename_invalid_characters'],
    ['"quoted".json', 'filename_invalid_characters'],
    ['CON.json', 'filename_reserved_name'],
    ['nul.txt', 'filename_reserved_name'],
    ['Com1.log', 'filename_reserved_name'],
    ['LPT9.csv', 'filename_reserved_name'],
    ['aux', 'filename_reserved_name'],
    ['file.json.', 'filename_trailing_dot_or_space'],
    ['file.json ', 'filename_trailing_dot_or_space'],
    ['.json', 'filename_hidden_file'],
    ['.htaccess', 'filename_hidden_file'],
    ['report.exe.txt', 'filename_double_extension'],
    ['x.php.json', 'filename_double_extension'],
    ['x.HTML.txt', 'filename_double_extension'],
    ['x.js.csv', 'filename_double_extension'],
    ['x.zip.md', 'filename_double_extension'],
    [`${'a'.repeat(MAX_FILE_NAME_LENGTH)}.json`, 'filename_too_long'],
    ['', 'filename_empty'],
    ['   ', 'filename_empty'],
  ];

  it.each(rejected)('rejects %j with %s and still returns a safe name', (name, code) => {
    const result = check(name, '{}');
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(code);
    expect(result.safeFileName).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
    expect(result.safeFileName).not.toContain('..');
    expect(result.safeFileName.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
  });

  it('accepts ordinary names, including several dots and non-ASCII letters', () => {
    expect(check('case.final.v2.json', '{}').ok).toBe(true);
    expect(check('log.2025-01-31.txt', 'x').ok).toBe(true);
    expect(check('Résumé case notes.txt', 'x').ok).toBe(true);
    expect(check('a-b_c.json', '{}').ok).toBe(true);
  });

  it('derives deterministic ASCII storage names', () => {
    expect(check('Résumé case notes.txt', 'x').safeFileName).toBe('Resume_case_notes.txt');
    expect(check('日本語 のメモ.txt', 'x').safeFileName).toBe('upload.txt'); // nothing ASCII survives in the stem
    expect(check('report.exe.txt', 'x').safeFileName).toBe('report_exe.txt');
    expect(check('../../etc/passwd.json', '{}').safeFileName).toBe('passwd.json');
    expect(check('C:\\temp\\x.json', '{}').safeFileName).toBe('x.json');
    expect(check('CON.json', '{}').safeFileName).toBe('_CON.json');
    expect(check('', '{}').safeFileName).toBe('upload');
    expect(check('...', '{}').safeFileName).toBe('upload');
    expect(check(`${'a'.repeat(200)}.json`, '{}').safeFileName).toBe(`${'a'.repeat(115)}.json`);
  });

  it('property: the storage name is always safe, whatever the client sent', () => {
    const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (name) => {
        const { safeFileName } = checkFileName(name);
        const stem = safeFileName.split('.')[0] ?? '';
        return (
          /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9]{1,10})?$/.test(safeFileName) &&
          safeFileName.length <= MAX_FILE_NAME_LENGTH &&
          !device.test(stem)
        );
      }),
      { numRuns: 500 },
    );
  });

  it('copes with a non-string name', () => {
    const result = validateUpload({
      fileName: undefined as unknown as string,
      bytes: enc('x'),
      maxBytes: MAX,
    });
    expect(result.ok).toBe(false);
    expect(result.safeFileName).toBe('upload');
  });

  it('never echoes hostile names back in issue messages', () => {
    const result = check('<script>alert(1)</script>.json', '{}');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain('script');
  });
});

describe('validateUpload: size [NFR-SEC-04]', () => {
  it('rejects empty files and files over the limit, but accepts exactly the limit', () => {
    expect(codes(check('a.txt', ''))).toEqual(['empty_file']);
    const limit = 1000;
    expect(check('a.txt', 'x'.repeat(limit), undefined, limit).ok).toBe(true);
    const over = check('a.txt', 'x'.repeat(limit + 1), undefined, limit);
    expect(codes(over)).toEqual(['file_too_large']);
    expect(over.sha256).toBe(sha256Hex('x'.repeat(limit + 1)));
  });

  it('does not run content checks on oversized files', () => {
    const big = new Uint8Array(2000).fill(0);
    expect(codes(check('a.txt', big, undefined, 1000))).toEqual(['file_too_large']);
  });

  it('refuses nonsensical limits', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => check('a.txt', 'x', undefined, maxBytes), String(maxBytes)).toThrow(RangeError);
    }
  });
});

describe('validateUpload: content sniffing [NFR-SEC-04]', () => {
  const signatures: [name: string, bytes: Uint8Array][] = [
    ['PDF', withHead([0x25, 0x50, 0x44, 0x46, 0x2d])],
    [
      'PDF after junk',
      (() => {
        const b = withHead([], 1000);
        b.set([0x25, 0x50, 0x44, 0x46, 0x2d], 700);
        return b;
      })(),
    ],
    ['ZIP', withHead([0x50, 0x4b, 0x03, 0x04])],
    ['empty ZIP', withHead([0x50, 0x4b, 0x05, 0x06])],
    ['Office (OOXML)', withHead([0x50, 0x4b, 0x03, 0x04])],
    ['PE', withHead([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])],
    ['ELF', withHead([0x7f, 0x45, 0x4c, 0x46])],
    ['gzip', withHead([0x1f, 0x8b, 0x08])],
    ['PNG', withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['JPEG', withHead([0xff, 0xd8, 0xff, 0xe0])],
    ['GIF87a', withHead([...enc('GIF87a')])],
    ['GIF89a', withHead([...enc('GIF89a')])],
    ['SQLite', withHead([...enc('SQLite format 3'), 0x00])],
    ['RAR', withHead([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])],
    ['7z', withHead([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])],
    ['OLE2', withHead([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ['Mach-O', withHead([0xcf, 0xfa, 0xed, 0xfe])],
    ['Java class', withHead([0xca, 0xfe, 0xba, 0xbe])],
    ['bzip2', withHead([...enc('BZh9')])],
    ['xz', withHead([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
    ['WebP', withHead([...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBP')])],
    ['MP4', withHead([0, 0, 0, 0x18, ...enc('ftypmp42')])],
  ];

  it.each(signatures)(
    '[NFR-SEC-04] rejects %s content even when name and type claim text',
    (_name, bytes) => {
      for (const [fileName, mediaType] of [
        ['a.txt', 'text/plain'],
        ['a.json', 'application/json'],
        ['a.csv', 'text/csv'],
        ['a.md', undefined],
      ] as const) {
        const result = check(fileName, bytes, mediaType);
        expect(result.ok, fileName).toBe(false);
        expect(codes(result), fileName).toContain('executable_or_archive_signature');
      }
    },
  );

  it('rejects NUL bytes anywhere and control-byte-heavy content', () => {
    const late = new Uint8Array([
      ...enc('looks like text for a while '),
      0x00,
      ...enc('then a NUL'),
    ]);
    expect(codes(check('a.txt', late))).toEqual(['binary_content']);
    const noisy = new Uint8Array(1000).map((_, i) => (i % 5 === 0 ? 0x01 : 0x61));
    expect(codes(check('a.log', noisy))).toEqual(['binary_content']);
  });

  it('rejects UTF-16 text and invalid UTF-8', () => {
    expect(codes(check('a.txt', new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])))).toEqual([
      'unsupported_encoding',
    ]);
    expect(codes(check('a.txt', new Uint8Array([0xfe, 0xff, 0x00, 0x68])))).toEqual([
      'unsupported_encoding',
    ]);
    for (const bad of [
      [0xc3, 0x28],
      [0xe2, 0x82],
      [0xf0, 0x28, 0x8c, 0xbc],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0x80],
    ]) {
      expect(codes(check('a.txt', new Uint8Array([...enc('ok '), ...bad]))), String(bad)).toEqual([
        'invalid_utf8',
      ]);
    }
  });

  it('rejects documents that would be active content if ever served inline', () => {
    for (const body of [
      '<!DOCTYPE html><html></html>',
      '  <html><body>x</body></html>',
      '<script>alert(1)</script>',
      '<svg onload=alert(1)></svg>',
      '<?php echo 1; ?>',
      '<iframe src=x></iframe>',
    ]) {
      expect(codes(check('a.txt', body)), body).toEqual(['active_content']);
    }
    expect(check('config.txt', '<?xml version="1.0"?><config/>').ok).toBe(true);
    expect(check('page.md', 'Text mentioning <html> in the middle').ok).toBe(true);
  });

  it('validates JSON syntax and depth without echoing the content', () => {
    for (const body of [
      '{"a":',
      '{a:1}',
      "{'a':1}",
      '[1,2,]',
      '',
      'not json',
      '{"a":1} trailing',
    ]) {
      if (body === '') continue;
      const result = check('a.json', body);
      expect(codes(result), body).toEqual(['invalid_json']);
      expect(JSON.stringify(result.issues)).not.toContain('trailing');
    }
    expect(codes(check('a.json', `${'['.repeat(65)}${']'.repeat(65)}`))).toEqual(['json_too_deep']);
    expect(codes(check('a.json', '['.repeat(500_000)))).toEqual(['json_too_deep']);
    expect(check('a.json', `{"s":"${'['.repeat(10_000)}"}`).ok).toBe(true); // brackets inside strings do not count
    expect(check('a.json', `{"s":"\\"${'['.repeat(100)}"}`).ok).toBe(true); // escaped quotes keep string state
  });

  it('only validates JSON for .json files', () => {
    expect(check('a.txt', '{not json').ok).toBe(true);
    expect(check('a.csv', '{not json').ok).toBe(true);
  });
});

describe('validateUpload: malicious metadata combinations [NFR-SEC-04]', () => {
  it('reports every problem for a hostile upload and never accepts it', () => {
    const result = check('../../evil.json', withHead([0x25, 0x50, 0x44, 0x46, 0x2d]), 'image/png');
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        'filename_path_traversal',
        'filename_path_separator',
        'media_type_not_allowed',
        'executable_or_archive_signature',
      ]),
    );
    expect(result.safeFileName).toBe('evil.json');
  });

  it('is decided by the bytes, not by what the name or type claims', () => {
    const exe = withHead([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const result = check('totally-harmless-notes.txt', exe, 'text/plain');
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('text');
  });

  it('computes the same hash regardless of the metadata', () => {
    const bytes = enc('same bytes');
    expect(check('a.txt', bytes).sha256).toBe(
      check('../x.exe', bytes, 'application/x-msdownload').sha256,
    );
  });
});

describe('malware scanners [NFR-SEC-04]', () => {
  it('the default scanner says plainly that nothing was scanned', async () => {
    const result = await new NoopMalwareScanner().scan(enc('anything'));
    expect(result).toEqual({
      status: 'not_scanned',
      engine: 'none',
      detail: 'No malware scanner is configured; this file was NOT scanned for malware.',
      signature: null,
    });
    expect(result.status).not.toBe('clean');
  });

  it('the EICAR scanner finds the standard test string wherever it is', async () => {
    const scanner = new EicarTestScanner();
    expect(EICAR_TEST_STRING).toHaveLength(68);
    for (const body of [
      EICAR_TEST_STRING,
      `${EICAR_TEST_STRING}\r\n`,
      `prefix\n${EICAR_TEST_STRING}\nsuffix`,
      `${'x'.repeat(5000)}${EICAR_TEST_STRING}`,
    ]) {
      const result = await scanner.scan(enc(body));
      expect(result.status).toBe('infected');
      expect(result.signature).toBe('EICAR-Test-File');
      expect(result.engine).toBe('eicar-test');
    }
  });

  it('works on views into larger buffers (offset and length are respected)', async () => {
    const scanner = new EicarTestScanner();
    const backing = new Uint8Array(enc(`junk${EICAR_TEST_STRING}junk`));
    const inside = new Uint8Array(backing.buffer, 4, 68);
    expect((await scanner.scan(inside)).status).toBe('infected');
    const outside = new Uint8Array(backing.buffer, 0, 4);
    expect((await scanner.scan(outside)).status).toBe('clean');
  });

  it('says honestly what a clean EICAR verdict means', async () => {
    const result = await new EicarTestScanner().scan(enc('ordinary text'));
    expect(result.status).toBe('clean');
    expect(result.detail).toMatch(/only recognises the EICAR test file/);
    expect(result.detail).toMatch(/not a real antivirus/);
    expect((await new EicarTestScanner().scan(enc('X5O!P%@AP[4 truncated EICAR'))).status).toBe(
      'clean',
    );
  });

  it('creates the scanner for each configured mode', () => {
    expect(createMalwareScanner('none')).toBeInstanceOf(NoopMalwareScanner);
    expect(createMalwareScanner('eicar-test')).toBeInstanceOf(EicarTestScanner);
  });
});
