import { IdSchema, SearchResultSchema } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../src/db';
import { mapDocuments, toValidResults } from '../src/services/search';
import { CONTOSO, hit } from './search-support';

const FABRIKAM = 'tenant_fabrikam_lab';

type Doc = Record<string, unknown>;

const doc = (overrides: Doc = {}): Doc => ({
  '@search.score': 2,
  id: 'case_a',
  tenantId: CONTOSO,
  type: 'case',
  title: 'Sign-in outage',
  snippet: 'Users cannot sign in.',
  ...overrides,
});

const without = (source: Doc, ...keys: string[]): Doc =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));

const GOOD = doc({ id: 'case_ok', title: 'Fine' });

const MALFORMED: readonly (readonly [string, unknown])[] = [
  [
    'a case id with a space (the review probe)',
    doc({ id: 'clm_1', type: 'claim', caseId: 'case 0001' }),
  ],
  ['an empty id', doc({ id: '' })],
  ['an id too long to be a link', doc({ id: 'a'.repeat(121) })],
  ['an index key too long even for the index', doc({ id: 'a'.repeat(301) })],
  ['an id with path characters', doc({ id: '../etc/passwd' })],
  ['an id that starts with a symbol', doc({ id: '-case' })],
  [
    'an entity id that is not an id',
    doc({ id: 'key_1', entityId: 'evt 1', type: 'event', caseId: 'case_a' }),
  ],
  ['an entity id that is empty', doc({ entityId: '' })],
  ['a case-scoped document without a case', doc({ id: 'evt_1', type: 'event' })],
  ['a case-scoped document with a null case', doc({ id: 'evt_1', type: 'event', caseId: null })],
  ['a case-scoped document with an empty case', doc({ id: 'evt_1', type: 'event', caseId: '' })],
  ['a case id that is too long', doc({ id: 'evt_1', type: 'event', caseId: 'c'.repeat(121) })],
  ['a missing title', without(doc(), 'title')],
  ['an empty title', doc({ title: '' })],
  ['a title that is only markup', doc({ title: '<script>alert(1)</script><b></b>' })],
  ['a title that is only blanks and control characters', doc({ title: ' \u0000\t ' })],
  ['a title that is not text', doc({ title: 42 })],
  ['a missing type', without(doc(), 'type')],
  ['an unknown type', doc({ type: 'folder' })],
  ['a missing score', without(doc(), '@search.score')],
  ['a score that is not a number', doc({ '@search.score': 'high' })],
  ['a negative score', doc({ '@search.score': -1 })],
  ['a score that is not finite', doc({ '@search.score': Number.POSITIVE_INFINITY })],
  ['a missing tenant', without(doc(), 'tenantId')],
  ['a snippet that is not text', doc({ snippet: { html: '<b>' } })],
  ['a snippet beyond the documented size', doc({ snippet: 'x'.repeat(20_001) })],
  ['text instead of an object', 'text'],
  ['null', null],
  ['a number', 42],
  ['an array', []],
];

describe('[FR-UX-04] index documents that cannot be shown (pure)', () => {
  it.each(MALFORMED)('drops %s, counts it and keeps the other documents', (_label, bad) => {
    const outcome = mapDocuments([bad, GOOD, bad], CONTOSO);
    expect(outcome.hits.map((entry) => entry.id)).toEqual(['case_ok']);
    expect(outcome).toMatchObject({ droppedInvalid: 2, droppedForeignTenant: 0 });
  });

  it('keeps documents that are unusual but valid; the type decides the link id and the case', () => {
    const outcome = mapDocuments(
      [
        doc({
          id: 'tenant_contoso_support:event:evt_9',
          entityId: 'evt_9',
          type: 'event',
          caseId: 'case_a',
          title: 'Check',
        }),
        doc({ id: 'k'.repeat(250), entityId: 'clm_7', type: 'claim', caseId: 'case_a' }),
        doc({ id: 'skill_1', type: 'skill', caseId: 'not a valid case id' }),
        doc({ id: 'case_b', type: 'case', caseId: 'case_zzz' }),
        doc({
          id: 'hyp_1',
          type: 'hypothesis',
          caseId: 'case_a',
          title: '日本語 😀',
          snippet: undefined,
        }),
        doc({ id: 'wrn_1', type: 'warning', caseId: 'case_a', snippet: null }),
      ],
      CONTOSO,
    );
    expect(outcome).toMatchObject({ droppedInvalid: 0, droppedForeignTenant: 0 });
    expect(outcome.hits.map((entry) => [entry.type, entry.id, entry.caseId])).toEqual([
      ['event', 'evt_9', 'case_a'],
      ['claim', 'clm_7', 'case_a'],
      ['skill', 'skill_1', null],
      ['case', 'case_b', 'case_b'],
      ['hypothesis', 'hyp_1', 'case_a'],
      ['warning', 'wrn_1', 'case_a'],
    ]);
    expect(outcome.hits[4]).toMatchObject({ title: '日本語 😀', snippet: '' });
    expect(outcome.hits[5]?.snippet).toBe('');
  });

  it('reports another tenant’s document as such even when it is also malformed, and never maps it', () => {
    const outcome = mapDocuments(
      [
        doc({ id: 'case_f1', tenantId: FABRIKAM, title: 'FOREIGN-ONE' }),
        without(doc({ id: 'case_f2', tenantId: FABRIKAM, title: 'FOREIGN-TWO' }), 'type'),
        doc({ id: 'clm_f3', tenantId: FABRIKAM, type: 'claim', caseId: 'bad id' }),
        GOOD,
      ],
      CONTOSO,
    );
    expect(outcome.droppedForeignTenant).toBe(3);
    expect(outcome.droppedInvalid).toBe(0);
    expect(outcome.hits.map((entry) => entry.id)).toEqual(['case_ok']);
    expect(JSON.stringify(outcome)).not.toContain('FOREIGN');
  });

  it('shows markup as plain text and drops a document whose title is nothing but markup', () => {
    const outcome = mapDocuments(
      [
        doc({
          id: 'case_h1',
          title: '<b>Resolver</b> <i>timeout</i>',
          snippet:
            '<p>The <a href="javascript:evil()">resolver</a> timed out.</p><script>alert(1)</script>',
        }),
        doc({ id: 'case_h2', title: 'Plain', snippet: '<img src=x onerror=alert(1)>' }),
        doc({ id: 'case_h3', title: '<script>alert(1)</script>' }),
      ],
      CONTOSO,
    );
    expect(outcome.droppedInvalid).toBe(1);
    expect(outcome.hits.map((entry) => [entry.title, entry.snippet])).toEqual([
      ['Resolver timeout', 'The resolver timed out.'],
      ['Plain', ''],
    ]);
  });
});

/** A small deterministic generator (mulberry32), so the same documents are tried on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Pool<T> {
  readonly valid: readonly T[];
  readonly invalid: readonly T[];
}

/** Values for each field of an index document; the generator draws mostly from the valid ones. */
const POOLS = {
  ids: {
    valid: ['case_a', 'evt_03', 'clm_01JABCDEFGHJKMNPQRSTVWXYZ0', 'ok-1.2_3', 'tenant:event:1'],
    invalid: ['a b', '', 'x'.repeat(121), '../x', 'a/b', '😀', '-lead', 'ünï', 'a?b=1', '<b>'],
  },
  entityIds: { valid: [undefined, undefined, null, 'evt_77'], invalid: ['bad id', ''] },
  types: {
    valid: ['case', 'claim', 'hypothesis', 'skill', 'warning', 'event'],
    invalid: ['folder', undefined],
  },
  caseIds: {
    valid: [undefined, null, 'case_a', 'case_b'],
    invalid: ['case 1', '', 'c'.repeat(121)],
  },
  titles: {
    valid: [
      'Resolver timeout',
      '<script>x</script>y',
      '<b>Bold</b> title',
      'A'.repeat(5000),
      '😀'.repeat(400),
      'a<b',
      'Ünï',
      'x'.repeat(1999),
    ],
    invalid: ['', '<b></b>', '  \t ', '<script>alert(1)</script>'],
  },
  snippets: {
    valid: [
      undefined,
      null,
      '',
      'ok',
      'y'.repeat(10_000),
      '<img src=x onerror=1>',
      '\u0000control\u0007',
      '😀'.repeat(250),
      `<p>${'z'.repeat(400)}</p>`,
    ],
    invalid: [{ html: '<b>' }, 'x'.repeat(20_001), 5],
  },
  scores: {
    valid: [0, 1, 4.5, 1e9],
    invalid: [1e9 + 1, -1, Number.NaN, Number.POSITIVE_INFINITY, '3', null],
  },
} as const;

describe('[FR-UX-04] every mapped hit satisfies the result contract (pure)', () => {
  it('holds for whatever the index returns: 800 generated documents, valid and not', () => {
    const next = generator(20_260_115);
    const pick = <T>(pool: Pool<T>): T => {
      const from = next() < 0.85 ? pool.valid : pool.invalid;
      return from[Math.floor(next() * from.length)] as T;
    };
    const documents = Array.from({ length: 800 }, () => ({
      '@search.score': pick(POOLS.scores),
      id: pick(POOLS.ids),
      entityId: pick(POOLS.entityIds),
      tenantId: next() < 0.1 ? FABRIKAM : CONTOSO,
      type: pick(POOLS.types),
      caseId: pick(POOLS.caseIds),
      title: pick(POOLS.titles),
      snippet: pick(POOLS.snippets),
    }));

    const outcome = mapDocuments(documents, CONTOSO);
    // Every document is accounted for, and the generator really makes both kinds.
    expect(outcome.hits.length + outcome.droppedInvalid + outcome.droppedForeignTenant).toBe(
      documents.length,
    );
    expect(outcome.droppedForeignTenant).toBe(
      documents.filter((document) => document.tenantId === FABRIKAM).length,
    );
    expect(outcome.hits.length).toBeGreaterThan(50);
    expect(outcome.droppedInvalid).toBeGreaterThan(50);

    const { results, discarded } = toValidResults(outcome.hits, documents.length);
    expect(discarded).toBe(0);
    expect(results).toHaveLength(outcome.hits.length);
    for (const result of results) {
      // The schema the response serializer enforces, and the ids that make the result a link.
      SearchResultSchema.parse(result);
      IdSchema.parse(result.id);
      if (result.caseId !== null) IdSchema.parse(result.caseId);
      expect(result.title).not.toBe('');
      expect(Array.from(result.snippet).length).toBeLessThanOrEqual(300);
      expect(`${result.title} ${result.snippet}`).not.toMatch(/<[A-Za-z/!?]/);
      expect(result.href).toMatch(/^\/(cases|skills)/);
    }
  });
});

describe('[FR-UX-04] the result contract (pure)', () => {
  it('drops hits that cannot satisfy it, counts them, and never throws', () => {
    const broken: SearchHit[] = [
      hit({ id: 'clm_1', type: 'claim', caseId: 'case 0001' }),
      hit({ id: '', caseId: '' }),
      hit({ id: 'x'.repeat(121), caseId: 'x'.repeat(121) }),
      hit({ type: 'event', id: 'evt_1', caseId: null }),
      hit({ type: 'skill', id: 'skill_1', caseId: 'case_a' }),
      hit({ type: 'case', id: 'case_a', caseId: 'case_b' }),
      hit({ title: '' }),
      hit({ score: Number.NaN }),
      { ...hit(), title: undefined } as unknown as SearchHit,
      null as unknown as SearchHit,
    ];
    const { results, discarded } = toValidResults(
      [...broken, hit({ id: 'case_ok', caseId: 'case_ok' })],
      25,
    );
    expect(results.map((result) => result.id)).toEqual(['case_ok']);
    expect(discarded).toBe(broken.length);
  });

  it('applies the limit to the hits that are left, and does not look past it', () => {
    const hits = [
      hit({ id: 'bad id', caseId: 'bad id' }),
      hit({ id: 'a', caseId: 'a' }),
      hit({ id: 'b', caseId: 'b' }),
      hit({ id: 'c', caseId: 'c' }),
      hit({ id: 'bad 2', caseId: 'bad 2' }),
    ];
    const two = toValidResults(hits, 2);
    expect(two.results.map((result) => result.id)).toEqual(['a', 'b']);
    expect(two.discarded).toBe(1);
    const all = toValidResults(hits, 10);
    expect(all.results.map((result) => result.id)).toEqual(['a', 'b', 'c']);
    expect(all.discarded).toBe(2);
    expect(toValidResults(hits, 0)).toEqual({ results: [], discarded: 0 });
  });

  it('accepts every kind of hit the repository produces, with the link of the web app', () => {
    const { results, discarded } = toValidResults(
      [
        hit({ type: 'case', id: 'case_alpha', caseId: 'case_alpha' }),
        hit({ type: 'skill', id: 'skill_proxy', caseId: null }),
        hit({ type: 'claim', id: 'clm_1' }),
        hit({ type: 'hypothesis', id: 'hyp_1' }),
        hit({ type: 'event', id: 'evt_03' }),
        hit({ type: 'warning', id: 'wrn_1' }),
      ],
      25,
    );
    expect(discarded).toBe(0);
    expect(results.map((result) => result.href)).toEqual([
      '/cases/case_alpha',
      '/skills/skill_proxy',
      '/cases/case_alpha/evidence?sel=clm_1',
      '/cases/case_alpha/hypotheses?sel=hyp_1',
      '/cases/case_alpha/timeline?sel=evt_03',
      '/cases/case_alpha/quality?sel=wrn_1',
    ]);
  });

  it('encodes the ids it links to, so no id can change the shape of the link', () => {
    const { results } = toValidResults(
      [hit({ type: 'event', id: 'e:1.x', caseId: 'case:2' }), hit({ id: 'a.b', caseId: 'a.b' })],
      25,
    );
    expect(results.map((result) => result.href)).toEqual([
      '/cases/case%3A2/timeline?sel=e%3A1.x',
      '/cases/a.b',
    ]);
  });
});
