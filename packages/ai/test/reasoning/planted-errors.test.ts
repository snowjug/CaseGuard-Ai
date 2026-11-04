import { describe, expect, it } from 'vitest';
import { PROPOSAL_CODES } from '../../src/reasoning/types';
import { MUTATIONS, POLICY_CASES, SEMANTIC_ERRORS, runMutation } from './planted-errors';
import { renderReport, runCorpus } from './planted-report';

const run = runCorpus();

describe('planted-error corpus: mechanical errors', () => {
  it('holds at least sixty mutations, with unique ids', () => {
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(MUTATIONS.map((m) => m.id)).size).toBe(MUTATIONS.length);
  });

  it('plants errors against every rule, at least twice each', () => {
    for (const code of PROPOSAL_CODES) {
      const planted = MUTATIONS.filter((m) => m.category === code).length;
      expect(planted, `${code} has ${planted} planted errors`).toBeGreaterThanOrEqual(2);
    }
  });

  it('covers the families the review has to resist: malformed and truncated JSON, an extra key, self-approval, a quotation of the wrong event, a future event, duplicates, huge output', () => {
    const tags = new Set(MUTATIONS.flatMap((m) => m.tags));
    for (const tag of [
      'malformed_json',
      'truncated',
      'extra_top_level_key',
      'self_approval',
      'wrong_event',
      'future_event',
      'duplicate',
      'huge_output',
    ]) {
      expect(tags.has(tag), tag).toBe(true);
    }
  });

  it.each(MUTATIONS.map((mutation) => ({ id: mutation.id, mutation })))(
    'catches $id',
    ({ mutation }) => {
      const result = runMutation(mutation);
      expect(result.caught, `${mutation.description} -> ${result.detail}`).toBe(true);
    },
  );

  it('catches every planted error, in every category: a catch rate of 100%', () => {
    for (const row of run.categories) expect(row.missed, row.category).toEqual([]);
    for (const row of run.families) expect(row.missed, row.category).toEqual([]);
    expect(run.mutations.filter((m) => !m.caught)).toEqual([]);
    expect(run.categories.reduce((n, r) => n + r.caught, 0)).toBe(MUTATIONS.length);
  });

  it('is deterministic: planting the same error twice gives the same report', () => {
    for (const mutation of MUTATIONS) {
      expect(runMutation(mutation).detail).toBe(runMutation(mutation).detail);
    }
  });

  it('leaves the other proposals alone: an error costs exactly the proposal it was planted in', () => {
    const single = run.mutations.filter(
      (m) => m.mutation.expect === 'dropped' && !m.mutation.check,
    );
    expect(single.length).toBeGreaterThan(50);
    for (const result of single) expect(result.caught, result.mutation.id).toBe(true);
  });
});

describe('planted-error corpus: what the policy makes of a grounded finding', () => {
  it.each(POLICY_CASES.map((c) => ({ id: c.id, policyCase: c })))('$id', ({ policyCase }) => {
    const result = run.policy.find((p) => p.case.id === policyCase.id);
    expect(result?.actual, policyCase.description).toBe(policyCase.expected);
  });
});

describe('planted-error corpus: semantic errors', () => {
  it('lists well-formed, grounded errors, at least five', () => {
    expect(SEMANTIC_ERRORS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(SEMANTIC_ERRORS.map((e) => e.id)).size).toBe(SEMANTIC_ERRORS.length);
  });

  it('passes every one of them through the mechanical rules: validation cannot catch them, and the report must say so', () => {
    for (const result of run.semantic) expect(result.passed, result.error.id).toBe(true);
  });
});

describe('planted-error report', () => {
  const markdown = renderReport(run);

  it('prints the catch rate per category, the policy outcomes and the semantic errors', () => {
    expect(markdown).toMatch(/^# Planted-error evaluation/);
    expect(markdown).toContain('## Mechanical errors, by rule that must catch them');
    expect(markdown).toContain('## Mechanical errors, by family named in the brief');
    expect(markdown).toContain('## What the hybrid policy makes of grounded findings');
    expect(markdown).toContain('## Semantic errors: well-formed, grounded, and wrong');
    expect(markdown).toContain(`${MUTATIONS.length} planted errors (${MUTATIONS.length} caught)`);
    expect(markdown).toContain('100%');
    expect(markdown).toContain('Every planted mechanical error was caught.');
  });

  it('says that mechanical validation cannot catch the semantic errors, and what was not run', () => {
    expect(markdown).toContain('not caught, by design');
    expect(markdown).toMatch(/A real model: NOT RUN/);
    expect(markdown).toMatch(/The critic: NOT RUN against a real model/);
    expect(markdown).toMatch(/measure nothing about a model/);
  });

  it('is plain Markdown tables and carries no text of the case', () => {
    expect(markdown).not.toContain('Contoso');
    expect(markdown.split('\n').filter((l) => l.startsWith('| ---')).length).toBeGreaterThanOrEqual(
      4,
    );
  });
});
