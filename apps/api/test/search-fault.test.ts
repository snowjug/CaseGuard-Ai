import { describe, expect, it, vi } from 'vitest';
import { toValidResults } from '../src/services/search';
import { hit } from './search-support';

// The redactor is the one step that builds a result from the content of a hit: here it is broken.
vi.mock('../src/services/governance/mask-secrets', () => ({
  maskSecrets: () => {
    throw new Error('redactor is broken');
  },
}));

describe('[NFR-SEC-05] a fault in building a result is not a dropped hit', () => {
  it('fails the request instead of hiding the fault, or returning unmasked text', () => {
    expect(() => toValidResults([hit({ id: 'case_ok', caseId: 'case_ok' })], 5)).toThrow(
      'redactor is broken',
    );
  });

  it('still drops hits that are junk without ever reaching the redactor', () => {
    const junk = [
      hit({ id: 'bad id', caseId: 'bad id' }),
      hit({ title: '' }),
      null as unknown as ReturnType<typeof hit>,
    ];
    expect(toValidResults(junk, 5)).toEqual({ results: [], discarded: 3 });
  });
});
