import type { Job } from '@caseguard/schemas';
import { CONTOSO, PERSONAS } from './app-harness';

export function fakeJob(caseId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_test_0001',
    tenantId: CONTOSO,
    kind: 'case_analysis',
    status: 'queued',
    caseId,
    targetId: null,
    progress: {
      percent: 0,
      stage: 'queue',
      stages: [
        {
          id: 'queue',
          label: 'Queued',
          status: 'pending',
          startedAt: null,
          completedAt: null,
          detail: null,
        },
      ],
    },
    error: null,
    resultRef: null,
    idempotencyKey: null,
    createdAt: '2026-01-15T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
    createdBy: PERSONAS.engineer,
    cancellable: true,
    ...overrides,
  };
}

/** Builds a multipart/form-data body by hand (no extra dependency needed). */
export function multipartBody(
  parts: readonly { name: string; filename?: string; type?: string; content: Buffer | string }[],
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----cgtest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      `Content-Disposition: form-data; name="${part.name}"` +
      (part.filename === undefined ? '' : `; filename="${part.filename}"`);
    const type = part.type === undefined ? '' : `Content-Type: ${part.type}\r\n`;
    chunks.push(
      Buffer.from(`--${boundary}\r\n${disposition}\r\n${type}\r\n`),
      Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
