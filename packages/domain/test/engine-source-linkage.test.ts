import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Claim, Evidence, SourceRef } from '@caseguard/schemas';
import { stableId } from '../src';
import { CASE_ONE, CASE_TWO, prepareBundle, prepareCase } from './helpers';
import { computeCase, linkageFreeDigests } from './engine-golden';
import { AWKWARD } from './source-linkage-fixtures';

interface Golden {
  engineVersion: string;
  cases: Record<
    'one' | 'two',
    { summary: Record<string, unknown>; digests: Record<string, string> }
  >;
}
const golden = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/engine-golden.json'), 'utf8'),
) as Golden;

const SAMPLES = [
  ['one', CASE_ONE],
  ['two', CASE_TWO],
] as const;

describe('source linkage changes where a value was found and nothing else', () => {
  for (const [name, file] of SAMPLES) {
    const expected = golden.cases[name];

    it(`${name}: every part of the analysis equals what ${golden.engineVersion} produced`, () => {
      const c = computeCase(prepareCase(file));
      // One digest per part, so a failure names the part that moved.
      expect(linkageFreeDigests(c)).toEqual(expected.digests);
    });

    it(`${name}: the headline figures are the ones before linkage`, () => {
      const { analysis, review, scenarios, warnings } = computeCase(prepareCase(file));
      expect({
        composite: review.compositeScore,
        low: review.compositeLow,
        high: review.compositeHigh,
        band: review.band,
        evidence: analysis.evidence.length,
        claims: analysis.claims.length,
        forks: analysis.forks.length,
        warnings: warnings.length,
        penalties: review.penalties.length,
        improvements: review.improvements.length,
        scenarios: scenarios.length,
        missing: analysis.missing.length,
        actions: analysis.actions.length,
        hypotheses: analysis.hypotheses.length,
        earliest: analysis.earliestMeaningfulForkId,
      }).toEqual(expected.summary);
    });
  }
});

describe('a source reference names the text its offsets count into', () => {
  const located = (ref: SourceRef | null): ref is SourceRef & Required<Pick<SourceRef, 'field'>> =>
    ref !== null && ref.field !== undefined;

  for (const [name, file] of SAMPLES) {
    const prepared = prepareCase(file);
    const { analysis } = computeCase(prepared);
    const eventById = new Map(prepared.normalized.events.map((e) => [e.id, e]));

    it(`${name}: offsets come with a field, and the pointer is true for that field`, () => {
      for (const item of [...analysis.evidence, ...analysis.claims]) {
        const ref = item.sourceRef;
        if (ref === null) continue;
        const event = eventById.get(ref.eventId ?? '');
        expect(event, item.id).toBeDefined();
        const hasOffsets = ref.start !== undefined || ref.end !== undefined;
        expect(hasOffsets, `${item.id}: offsets and field go together`).toBe(
          ref.field !== undefined,
        );
        const base = event?.sourcePointer ?? '';
        const expectedPointer =
          ref.field === 'title' ? `${base}/title` : ref.field === 'body' ? `${base}/body` : base;
        expect(ref.pointer, item.id).toBe(expectedPointer);
      }
    });

    it(`${name}: a claim made from evidence carries that evidence's location`, () => {
      const evidenceById = new Map<string, Evidence>(analysis.evidence.map((e) => [e.id, e]));
      const fromEvidence = analysis.claims.filter((c) => c.ruleId.startsWith('evidence.'));
      expect(fromEvidence.length).toBeGreaterThan(0);
      for (const claim of fromEvidence) {
        const source = evidenceById.get(claim.supportingEvidenceIds[0] ?? '');
        expect(source, claim.id).toBeDefined();
        expect(claim.sourceRef, claim.id).toEqual(source?.sourceRef);
      }
    });

    it(`${name}: structured and derived values claim no location at all`, () => {
      const structured = analysis.evidence.filter((e) => e.method === 'structured');
      const derived = analysis.claims.filter((c) => c.method === 'derived');
      for (const item of [...structured, ...derived]) {
        const ref = item.sourceRef;
        if (ref === null) continue;
        expect([ref.field, ref.start, ref.end], `${item.id}: nothing to point at`).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
        const event = eventById.get(ref.eventId ?? '');
        if (event) expect(ref.pointer).toBe(event.sourcePointer);
      }
    });
  }

  it('counts a match in the body from the start of the body, not from the start of the title', () => {
    const prepared = prepareCase(CASE_ONE);
    const { analysis } = computeCase(prepared);
    const affected = analysis.evidence.find(
      (e) => located(e.sourceRef) && e.excerpt.includes('roughly 140 users'),
    );
    const event = prepared.normalized.events.find((e) => e.id === affected?.eventId);
    expect(event?.title).toBeTruthy();
    expect(affected?.sourceRef.field).toBe('body');
    // Before this change the offsets counted the title and its line break as well.
    expect(event?.body.slice(affected?.sourceRef.start, affected?.sourceRef.end)).toBe('140 users');
    expect(affected?.sourceRef.pointer).toBe(`${event?.sourcePointer}/body`);
  });

  it('counts a match in the title from the start of the title', () => {
    const prepared = prepareCase(CASE_ONE);
    const { analysis } = computeCase(prepared);
    const inTitle = analysis.evidence.find((e) => e.sourceRef.field === 'title');
    const event = prepared.normalized.events.find((e) => e.id === inTitle?.eventId);
    expect(event?.title?.slice(inTitle?.sourceRef.start, inTitle?.sourceRef.end)).toBe(
      'intermittently',
    );
    expect(inTitle?.sourceRef.pointer).toBe(`${event?.sourcePointer}/title`);
  });
});

describe('awkward places in the text', () => {
  const { analysis, normalized } = prepareBundle(AWKWARD, 'case_awkward');
  const eventOf = (id: string) => normalized.events.find((e) => e.id === id);

  it('a match across the line break between the title and the body counts into both', () => {
    const crossing = analysis.evidence.find((e) => e.sourceRef.field === 'titleAndBody');
    expect(crossing, 'the AzureAdPrt signal fired').toBeDefined();
    const event = eventOf('a01');
    expect(crossing?.sourceRef.pointer).toBe(event?.sourcePointer);
    expect(
      `${event?.title}\n${event?.body}`.slice(crossing?.sourceRef.start, crossing?.sourceRef.end),
    ).toMatch(/^AzureAdPrt\n: YES/);
    const claim = analysis.claims.find((c) => c.supportingEvidenceIds[0] === crossing?.id);
    expect(claim?.sourceRef).toEqual(crossing?.sourceRef);
  });

  it('a statement that starts after spaces points at its first word', () => {
    const event = eventOf('a02');
    const statements = analysis.claims.filter(
      (c): c is Claim => c.ruleId.startsWith('statement.') && c.eventId === 'a02',
    );
    const texts = statements.map((c) => c.text);
    expect(texts).toContain('The root cause is the DNS resolver policy.');
    expect(texts).toContain('Probably a stale cache as well.');
    for (const claim of statements) {
      const { start, end } = claim.sourceRef ?? {};
      expect(event?.body.slice(start, end), claim.id).toBe(claim.text);
      expect(claim.sourceRef?.field).toBe('body');
    }
  });

  it('keeps every claim id as it was: it still names the start of the line, margin included', () => {
    const event = eventOf('a02');
    const byText = new Map(
      analysis.claims
        .filter((c) => c.ruleId.startsWith('statement.') && c.eventId === 'a02')
        .map((c) => [c.text, c]),
    );
    const root = byText.get('The root cause is the DNS resolver policy.');
    const stale = byText.get('Probably a stale cache as well.');
    const rootLine = event?.body.indexOf('    The root cause') ?? -1;
    const staleLine = event?.body.indexOf('\t  Probably') ?? -1;
    expect(rootLine).toBeGreaterThan(0);
    expect(root?.id).toBe(stableId('clm', 'case_awkward', root?.ruleId ?? '', `a02:${rootLine}`));
    expect(stale?.id).toBe(
      stableId('clm', 'case_awkward', stale?.ruleId ?? '', `a02:${staleLine}`),
    );
    // The offset that points at the words is a different number.
    expect(root?.sourceRef?.start).toBe(rootLine + 4);
    expect(stale?.sourceRef?.start).toBe(staleLine + 3);
  });
});
