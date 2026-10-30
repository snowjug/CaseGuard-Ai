import { describe, expect, it, vi } from 'vitest';
import type { Case } from '@caseguard/schemas';
import type { TenantRepositories } from '../src/db';
import { ConflictError } from '../src/errors';
import {
  findCaseByReference,
  referenceConflict,
  referenceInUseMessage,
} from '../src/services/ingestion/reference';
import { buildCase } from './builders';

/** Repositories that can only do the exact lookup: any other read of the case table is a TypeError. */
function reposWith(found: Case | null) {
  const findByReference = vi.fn((_reference: string) => Promise.resolve(found));
  return {
    repos: { cases: { findByReference } } as unknown as TenantRepositories,
    findByReference,
  };
}

describe('findCaseByReference (preview and create share it)', () => {
  it('asks the exact lookup once and returns the case that has the reference', async () => {
    const stored = buildCase({ id: 'case_b', reference: 'CG-10' });
    const { repos, findByReference } = reposWith(stored);
    expect(await findCaseByReference(repos, 'CG-10')).toBe(stored);
    expect(findByReference).toHaveBeenCalledTimes(1);
    expect(findByReference).toHaveBeenCalledWith('CG-10');
  });

  it('answers null when no case of the workspace has it, without searching or paging', async () => {
    const { repos, findByReference } = reposWith(null);
    expect(await findCaseByReference(repos, 'CG-10')).toBeNull();
    expect(findByReference).toHaveBeenCalledTimes(1);
  });
});

describe('the reference conflict', () => {
  it('is worded for any source of the payload and names the reference', () => {
    expect(referenceInUseMessage('CG-10')).toBe(
      'A case with reference CG-10 already exists in this workspace with different content. Use a different case reference, or delete the existing case first.',
    );
  });

  it('is a 409 that the service can tell from any other conflict, with the same text as the preview', () => {
    const error = referenceConflict('CG-10');
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({
      status: 409,
      code: 'conflict',
      message: referenceInUseMessage('CG-10'),
      details: { reason: 'reference_in_use' },
    });
  });
});
