import { describe, expect, it } from 'vitest';
import {
  collectCitations,
  collectEventRefs,
  collectProposalTexts,
  isRecord,
  normaliseExcerpt,
  sanitisePath,
} from '../../src/reasoning/text';
import { proposal } from './fixtures';

describe('sanitising a path for a report', () => {
  it('keeps the characters of the keys we wrote and drops every other', () => {
    expect(sanitisePath('evidence[0].excerpt')).toBe('evidence[0].excerpt');
    expect(sanitisePath('keyPoints[2].evidence[1]')).toBe('keyPoints[2].evidence[1]');
    expect(sanitisePath('result.critiques[3]')).toBe('result.critiques[3]');
  });

  it('removes what a model could put in a key name, so it never reaches a log', () => {
    expect(sanitisePath('a key with spaces and <script>')).toBe('akeywithspacesandscript');
    expect(sanitisePath('"; DROP TABLE x;--')).toBe('DROPTABLEx--');
    expect(sanitisePath('ünïcödé')).toBe('ncd');
  });

  it('is never empty and never longer than 120 characters', () => {
    expect(sanitisePath('')).toBe('$');
    expect(sanitisePath('   !!! ')).toBe('$');
    expect(sanitisePath('x'.repeat(500))).toHaveLength(120);
  });
});

describe('what counts as a record', () => {
  it('is an object that is not null and not a list', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('normalising a quotation', () => {
  it('composes Unicode, collapses whitespace runs and trims, and changes nothing else', () => {
    expect(normaliseExcerpt('  Cafe\u0301 \n\n au\tlait ')).toBe('Caf\u00e9 au lait');
    expect(normaliseExcerpt('Case STAYS')).toBe('Case STAYS');
  });
});

describe('the texts of a proposal', () => {
  it('separates what the model wrote from what it quoted', () => {
    const { own, quoted } = collectProposalTexts(proposal('signal'));
    expect(quoted.map((t) => t.path)).toEqual(['evidence[0].excerpt']);
    expect(own.map((t) => t.path)).toEqual(
      expect.arrayContaining(['statement', 'reasoning', 'uncertainty.note']),
    );
    expect(own.some((t) => t.path.endsWith('excerpt'))).toBe(false);
  });

  it('does not read ids, references or enumerated values as text', () => {
    const { own } = collectProposalTexts(proposal('missed_step'));
    const paths = own.map((t) => t.path);
    for (const skipped of [
      'id',
      'type',
      'actionId',
      'decisionEventId',
      'confidence',
      'confidenceBasis',
    ]) {
      expect(paths, skipped).not.toContain(skipped);
    }
    expect(paths.some((p) => p.startsWith('availableEventIds'))).toBe(false);
    expect(paths).toContain('step');
  });

  it('reads every text of a synthesis, key points and open questions included', () => {
    const { own, quoted } = collectProposalTexts(proposal('case_synthesis'));
    expect(own.map((t) => t.path)).toEqual(
      expect.arrayContaining(['summary', 'keyPoints[0].point', 'openQuestions[0]']),
    );
    expect(quoted.map((t) => t.path)).toEqual(
      expect.arrayContaining(['evidence[0].excerpt', 'keyPoints[0].evidence[0].excerpt']),
    );
  });

  it('reads the text of an unknown key too: nothing a model adds is exempt', () => {
    const { own } = collectProposalTexts({ ...proposal('signal'), remark: 'hidden advice' });
    expect(own.map((t) => t.path)).toContain('remark');
  });
});

describe('the events a proposal names', () => {
  it('lists each reference with where it is and what it is for', () => {
    const refs = collectEventRefs(proposal('contradiction'));
    expect(refs.map((r) => [r.path, r.eventId, r.role])).toEqual([
      ['sides[0].eventId', 'e2', 'side'],
      ['sides[1].eventId', 'e1', 'side'],
      ['evidence[0].eventId', 'e1', 'evidence'],
    ]);
  });

  it('knows the anchor of a decision and the events that were available', () => {
    const refs = collectEventRefs(proposal('missed_step'));
    expect(refs.map((r) => [r.path, r.role])).toEqual(
      expect.arrayContaining([
        ['decisionEventId', 'anchor'],
        ['availableEventIds[0]', 'available'],
        ['evidence[0].eventId', 'evidence'],
      ]),
    );
    expect(collectEventRefs(proposal('missing_evidence')).map((r) => r.path)).toContain(
      'neededByEventId',
    );
  });

  it('names an event cited as what cuts against the proposal', () => {
    const refs = collectEventRefs(
      proposal('signal', { contradictions: [{ eventId: 'e5', note: 'The cache was cleared.' }] }),
    );
    expect(refs.find((r) => r.eventId === 'e5')?.role).toBe('contradiction');
  });

  it('finds nothing in a value that is not a proposal', () => {
    expect(collectEventRefs('text')).toEqual([]);
    expect(collectEventRefs(null)).toEqual([]);
  });
});

describe('the citations of a proposal', () => {
  it('lists every event and excerpt pair with its path', () => {
    expect(collectCitations(proposal('signal'))).toEqual([
      {
        path: 'evidence[0]',
        eventId: 'e3',
        excerpt: 'The sign-in log shows AADSTS50076 for the three sample users.',
      },
    ]);
    const synthesis = collectCitations(proposal('case_synthesis'));
    expect(synthesis.map((c) => c.path).sort()).toEqual([
      'evidence[0]',
      'keyPoints[0].evidence[0]',
    ]);
  });
});
