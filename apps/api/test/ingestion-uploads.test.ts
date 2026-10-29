import { describe, expect, it } from 'vitest';
import { EICAR_TEST_STRING, createMalwareScanner } from '@caseguard/security';
import {
  PayloadTooLargeError,
  UnsafeContentError,
  UnsupportedMediaTypeError,
  ValidationFailedError,
} from '../src/errors';
import { findExample } from '../src/samples';
import { runPipeline } from '../src/services/ingestion/pipeline';
import { pipelineEnv, refusalOf, transcriptOf, uploadOf } from './ingestion-fixtures';

const csvExample = findExample('events-teams-signin-proxy')?.text ?? '';
const bundleExample = findExample('minimal-case-bundle')?.text ?? '';

describe('uploads through the pipeline (FR-ING-05)', () => {
  it('[FR-ING-05] previews a CSV upload with a sanitised name and says it was not scanned', async () => {
    expect(await refusalOf(uploadOf('../../export.csv', csvExample, 'text/csv'))).toBeInstanceOf(
      UnsafeContentError,
    );

    const odd = await runPipeline(
      { type: 'file', file: uploadOf('My Export (1).csv', csvExample, 'application/vnd.ms-excel') },
      pipelineEnv(),
    );
    expect(odd.preview).toMatchObject({ ok: true, sourceKind: 'uploaded_file' });
    expect(odd.prepared?.fileName).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
    const scanNote = odd.preview.issues.find((issue) => issue.path === 'file');
    expect(scanNote).toMatchObject({ severity: 'warning' });
    expect(scanNote?.message).toContain('NOT scanned');
  });

  it('[FR-ING-05] a JSON bundle upload declares its own label: no derived-label note', async () => {
    const outcome = await runPipeline(
      { type: 'file', file: uploadOf('bundle.json', bundleExample, 'application/json') },
      pipelineEnv(),
    );
    expect(outcome.preview.ok).toBe(true);
    expect(outcome.preview.issues.some((issue) => issue.path === 'synthetic')).toBe(false);
  });

  it('[FR-ING-05] rejects a wrong extension or Content-Type as 415', async () => {
    expect(
      await refusalOf(uploadOf('payload.exe', 'hello', 'application/octet-stream')),
    ).toBeInstanceOf(UnsupportedMediaTypeError);
    expect(await refusalOf(uploadOf('case.json', '{}', 'application/pdf'))).toBeInstanceOf(
      UnsupportedMediaTypeError,
    );
    expect(await refusalOf(uploadOf('case.csv', 'a,b', 'text/html'))).toBeInstanceOf(
      UnsupportedMediaTypeError,
    );
  });

  it('[FR-ING-05] rejects binary content, executables and active content as 422 unsafe, whatever the name says', async () => {
    const nul = await refusalOf(
      uploadOf('events.csv', Buffer.from([0x61, 0x2c, 0x00, 0x62, 0x0a]), 'text/csv'),
    );
    expect(nul).toBeInstanceOf(UnsafeContentError);
    expect(nul.status).toBe(422);

    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 1)]);
    expect(await refusalOf(uploadOf('events.csv', pe, 'text/csv'))).toBeInstanceOf(
      UnsafeContentError,
    );

    expect(
      await refusalOf(
        uploadOf(
          'notes.txt',
          '<!DOCTYPE html><html><script>alert(1)</script></html>',
          'text/plain',
        ),
      ),
    ).toBeInstanceOf(UnsafeContentError);

    const badUtf8 = Buffer.from([0x68, 0x69, 0xc3, 0x28]);
    expect(await refusalOf(uploadOf('notes.txt', badUtf8, 'text/plain'))).toBeInstanceOf(
      UnsafeContentError,
    );
  });

  it('[FR-ING-05] rejects a file over the limit as 413 and an empty file as 422', async () => {
    const tooLarge = await refusalOf(uploadOf('notes.txt', '12345678901', 'text/plain'), {
      uploadMaxBytes: 10,
    });
    expect(tooLarge).toBeInstanceOf(PayloadTooLargeError);
    expect(tooLarge.status).toBe(413);

    const empty = await refusalOf(uploadOf('notes.txt', '', 'text/plain'));
    expect(empty).toBeInstanceOf(ValidationFailedError);
    expect(empty.status).toBe(422);
  });

  it('[FR-ING-05] runs the malware scanner hook and never echoes the file when it refuses', async () => {
    const infected = await refusalOf(
      uploadOf('notes.txt', `hello ${EICAR_TEST_STRING}`, 'text/plain'),
      { scanner: createMalwareScanner('eicar-test') },
    );
    expect(infected).toBeInstanceOf(UnsafeContentError);
    expect(infected.message).toContain('malware scanner');
    expect(infected.message).not.toContain('EICAR-STANDARD');

    const clean = await runPipeline(
      { type: 'file', file: uploadOf('notes.txt', transcriptOf(['One.', 'Two.']), 'text/plain') },
      pipelineEnv({ scanner: createMalwareScanner('eicar-test') }),
    );
    expect(clean.preview.ok).toBe(true);
    expect(clean.preview.issues.find((issue) => issue.path === 'file')?.message).toContain(
      'not a real antivirus',
    );
  });

  it('[FR-ING-05] explains a JSON syntax error with its position instead of refusing the upload', async () => {
    const outcome = await runPipeline(
      { type: 'file', file: uploadOf('bundle.json', '{"schemaVersion": ', 'application/json') },
      pipelineEnv(),
    );
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.preview.issues[0]).toMatchObject({ severity: 'error' });
  });

  it('[FR-ING-05] refuses prototype-pollution keys in a JSON upload with a field-level error', async () => {
    const text = '{"__proto__": {"polluted": true}, "schemaVersion": "caseguard.case-bundle/1"}';
    const outcome = await runPipeline(
      { type: 'file', file: uploadOf('bundle.json', text, 'application/json') },
      pipelineEnv(),
    );
    expect(outcome.preview.ok).toBe(false);
    expect(outcome.preview.issues[0]?.message).toContain('not allowed');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
