import { describe, expect, it } from 'vitest';
import { checkSchema } from '../../../src/reasoning/rules/schema';
import { proposal } from '../fixtures';

const codes = (type: Parameters<typeof checkSchema>[0], raw: unknown) =>
  checkSchema(type, raw).issues.map((i) => i.code);

describe('rule schema', () => {
  it('parses a valid proposal of every type and reports nothing', () => {
    for (const type of [
      'signal',
      'contradiction',
      'missing_evidence',
      'missed_step',
      'counterfactual',
      'recommendation',
      'case_synthesis',
    ] as const) {
      const result = checkSchema(type, proposal(type));
      expect(result.issues).toEqual([]);
      expect(result.parsed?.type).toBe(type);
    }
  });

  it('reports an unknown key, a missing key and a value that is not allowed', () => {
    expect(codes('signal', proposal('signal', { extra: 1 }))).toEqual(['schema']);
    const { signalId: _gone, ...without } = proposal('signal');
    expect(codes('signal', without)).toEqual(['schema']);
    expect(codes('signal', proposal('signal', { confidence: 'certain' }))).toEqual(['schema']);
    expect(codes('signal', proposal('signal', { confidenceBasis: 'vibes' }))).toEqual(['schema']);
    expect(codes('signal', proposal('signal', { id: 'S 1' }))).toEqual(['schema']);
    expect(codes('counterfactual', proposal('counterfactual', { basis: 'a_guess' }))).toEqual([
      'schema',
    ]);
  });

  it('reports a number where text is expected and the other way round', () => {
    expect(codes('signal', proposal('signal', { statement: 7 }))).toEqual(['schema']);
    expect(codes('signal', proposal('signal', { evidence: 'The sign-in log' }))).toEqual([]);
    expect(codes('missing_evidence', proposal('missing_evidence', { requirementId: 3 }))).toEqual([
      'schema',
    ]);
  });

  it('is not an object at all', () => {
    for (const raw of [null, 'text', 7, [], undefined]) {
      expect(codes('signal', raw).length).toBeGreaterThan(0);
      expect(checkSchema('signal', raw).parsed).toBeNull();
    }
  });

  it('refuses a proposal filed under the wrong type', () => {
    expect(codes('signal', proposal('recommendation'))).toContain('schema');
    expect(checkSchema('signal', proposal('recommendation')).parsed).toBeNull();
  });

  it('leaves to the other rules what they report under their own code', () => {
    // Too long (excessive_output), no citation (missing_evidence), a server-only field (prohibited_field), a basis
    // only the engine may use (model_basis_overclaim).
    expect(codes('signal', proposal('signal', { statement: 'x'.repeat(301) }))).toEqual([]);
    expect(codes('signal', proposal('signal', { evidence: [] }))).toEqual([]);
    expect(codes('signal', proposal('signal', { approved: true }))).toEqual([]);
    expect(codes('counterfactual', proposal('counterfactual', { basis: 'measured' }))).toEqual([]);
    expect(
      codes('counterfactual', proposal('counterfactual', { basis: 'deterministic_estimate' })),
    ).toEqual([]);
    // ... but the proposal is still not accepted as parsed.
    expect(checkSchema('signal', proposal('signal', { evidence: [] })).parsed).toBeNull();
  });

  it('still reports an unknown key that is not a server-only field, next to one that is', () => {
    expect(codes('signal', proposal('signal', { approved: true, extra: 1 }))).toEqual(['schema']);
  });

  it('does not echo what the model wrote', () => {
    const issues = checkSchema(
      'signal',
      proposal('signal', { 'k\u0000ey<b>': 'x', confidence: 'S3CR3T' }),
    ).issues;
    expect(JSON.stringify(issues)).not.toMatch(/S3CR3T|<b>/);
  });
});
