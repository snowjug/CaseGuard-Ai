import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EICAR_TEST_STRING } from '@caseguard/security';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { findExample } from '../src/samples';
import {
  CREATE_FILE_URL,
  PREVIEW_FILE_URL,
  csvWith,
  leakSurface,
  openHarness,
  openWarmDatabase,
  resetDatabase,
  storedObjects,
  uploadFile,
} from './ingestion-support';
import { CONTOSO, PERSONAS, type Harness } from './support/app-harness';

let database: Database;
const harnesses: Harness[] = [];

beforeAll(async () => {
  database = await openWarmDatabase();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const h of harnesses) await h.close();
  await database.close();
});

beforeEach(() => resetDatabase(database));

const upload = uploadFile;
const PREVIEW_URL = PREVIEW_FILE_URL;
const CREATE_URL = CREATE_FILE_URL;

const csvExample = findExample('events-teams-signin-proxy')?.text ?? '';
const transcriptExample = findExample('transcript-teams-signin-proxy')?.text ?? '';
const bundleExample = findExample('minimal-case-bundle')?.text ?? '';

describe('hostile uploads (FR-ING-05)', () => {
  it('[FR-ING-05] rejects a file over UPLOAD_MAX_BYTES with 413 on both routes and stores nothing', async () => {
    const { h } = await openHarness(database, harnesses, { env: { UPLOAD_MAX_BYTES: '1024' } });
    const big = csvWith('x'.repeat(2000));
    for (const url of [PREVIEW_URL, CREATE_URL]) {
      const res = await upload(h, PERSONAS.engineer, url, 'events.csv', big, 'text/csv');
      expect(res.statusCode, url).toBe(413);
      expect(res.data.code).toBe('payload_too_large');
    }
    expect(storedObjects(h)).toEqual([]);
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('[FR-ING-05] rejects a wrong extension or Content-Type with 415', async () => {
    const { h } = await openHarness(database, harnesses);
    const cases: [string, string, string][] = [
      ['payload.exe', 'hello', 'application/octet-stream'],
      ['events.csv', csvExample, 'text/html'],
      ['bundle.json', bundleExample, 'application/pdf'],
      ['bundle.json', bundleExample, 'text/csv'],
    ];
    for (const [name, content, type] of cases) {
      const res = await upload(h, PERSONAS.engineer, CREATE_URL, name, content, type);
      expect(res.statusCode, `${name} as ${type}`).toBe(415);
      expect(res.data.code).toBe('unsupported_media_type');
    }
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('[FR-ING-05] accepts an unspecified Content-Type for a known extension (browsers send octet-stream)', async () => {
    const { h } = await openHarness(database, harnesses);
    const res = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'notes.log',
      transcriptExample,
      'application/octet-stream',
    );
    expect(res.statusCode).toBe(200);
    expect(res.data.ok).toBe(true);
  });

  it('[FR-ING-05] rejects binary, executable, archive, markup and badly encoded content with 422, whatever the name says', async () => {
    const { h } = await openHarness(database, harnesses);
    const cases: [string, Buffer | string, string][] = [
      ['events.csv', Buffer.from([0x61, 0x2c, 0x00, 0x62, 0x0a]), 'text/csv'],
      ['events.csv', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 1)]), 'text/csv'],
      ['bundle.json', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), 'application/json'],
      ['notes.txt', '<!DOCTYPE html><html><script>alert(1)</script></html>', 'text/plain'],
      ['notes.txt', Buffer.from([0x68, 0x69, 0xc3, 0x28]), 'text/plain'],
      ['notes.txt', Buffer.from([0xff, 0xfe, 0x68, 0x00]), 'text/plain'],
    ];
    for (const [index, [name, content, type]] of cases.entries()) {
      const res = await upload(h, PERSONAS.engineer, CREATE_URL, name, content, type);
      expect(res.statusCode, `case ${index}`).toBe(422);
      expect(res.data.code, `case ${index}`).toBe('unsafe_content');
      expect(res.data.reason, `case ${index}`).toBe('file_refused');
    }
    expect((await h.repos(CONTOSO).cases.list({ limit: 10 })).items).toEqual([]);
  });

  it('[FR-ING-05] rejects an empty file with 422 and a hostile file name with 415 or 422', async () => {
    const { h } = await openHarness(database, harnesses);
    const empty = await upload(h, PERSONAS.engineer, CREATE_URL, 'events.csv', '', 'text/csv');
    expect(empty.statusCode).toBe(422);
    for (const name of ['CON.csv', '.hidden.csv', 'events.csv.exe']) {
      const res = await upload(h, PERSONAS.engineer, CREATE_URL, name, csvExample, 'text/csv');
      expect([415, 422], name).toContain(res.statusCode);
    }
    expect(storedObjects(h)).toEqual([]);
  });

  it('[FR-ING-05] runs the malware scanner hook: an EICAR file is refused and never echoed or stored', async () => {
    const { h } = await openHarness(database, harnesses, {
      env: { MALWARE_SCAN_MODE: 'eicar-test' },
    });
    const content = `hello\n${EICAR_TEST_STRING}\n`;
    for (const url of [PREVIEW_URL, CREATE_URL]) {
      const res = await upload(h, PERSONAS.engineer, url, 'notes.txt', content, 'text/plain');
      expect(res.statusCode, url).toBe(422);
      expect(res.data.code).toBe('unsafe_content');
      expect(res.data.reason).toBe('file_refused');
      expect(res.data.detail).toContain('malware scanner');
      expect(res.body).not.toContain('EICAR-STANDARD');
    }
    expect(h.logs().some((line) => line.event === 'ingest.unsafe_upload_refused')).toBe(true);
    expect(storedObjects(h)).toEqual([]);
    expect(await leakSurface(h)).not.toContain('EICAR-STANDARD');

    const clean = await upload(
      h,
      PERSONAS.engineer,
      PREVIEW_URL,
      'events.csv',
      csvExample,
      'text/csv',
    );
    expect(clean.statusCode).toBe(200);
    expect(
      clean.data.issues.find((issue: { path: string }) => issue.path === 'file').message,
    ).toContain('not a real antivirus');
  });
});
