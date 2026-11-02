import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseEvent } from '@caseguard/schemas';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { CONTOSO, createHarness, openSharedDatabase, type Harness } from './support/app-harness';
import { ingestAndAnalyse } from './skills-support';
import {
  EVIDENCE_FREE,
  auditRecommendations,
  recommendationsOf,
  resolveAll,
} from './recommendations-support';
import { AS_OF_SUFFIXES, eventBySuffix } from './views-support';

/*
 * Every recommendation the product makes can be checked: it cites something in the record or is on a
 * short, argued allow-list; every link it cites resolves through `provenance.resolve`, in the whole record
 * and in earlier windows; and every citation of text is verified against the stored message.
 */

const ONE = 'case_rec_one';
const TWO = 'case_rec_two';

let database: Database;
let h: Harness;
let oneEvents: CaseEvent[];
let twoEvents: CaseEvent[];

beforeAll(async () => {
  database = await openSharedDatabase();
  h = await createHarness({ database });
  await ingestAndAnalyse(h, { one: ONE, two: TWO });
  oneEvents = await h.repos(CONTOSO).cases.getAllEvents(ONE);
  twoEvents = await h.repos(CONTOSO).cases.getAllEvents(TWO);
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  await h.close();
  await database.close();
});

describe('the whole record of both samples', () => {
  it('Case One: every item cites something, every link resolves, every cited text is verified', async () => {
    expect(await auditRecommendations(h, ONE)).toEqual([]);
  });

  it('Case Two: the same, apart from the five items on the allow-list', async () => {
    expect(await auditRecommendations(h, TWO)).toEqual([]);
  });

  it('covers every kind of recommendation the product makes', async () => {
    const one = await recommendationsOf(h, ONE);
    const kinds = new Set(one.items.map((item) => item.kind));
    expect([...kinds].sort()).toEqual([
      'coaching',
      'improvement',
      'penalty',
      'sub-check',
      'warning',
    ]);
    expect(one.items.length).toBeGreaterThan(40);
    const two = await recommendationsOf(h, TWO);
    expect(two.items.length).toBeGreaterThan(15);
    // The two links of each kind of source that a person can read.
    const cited = [...one.items, ...two.items].flatMap((item) => item.links.map((l) => l.type));
    for (const type of [
      'event',
      'claim',
      'evidence',
      'fork',
      'action',
      'hypothesis',
      'requirement',
    ]) {
      expect(cited, type).toContain(type);
    }
  });

  it('every allow-list entry names a reason that is more than a label', () => {
    for (const [key, reason] of Object.entries(EVIDENCE_FREE)) {
      expect(reason.length, key).toBeGreaterThan(60);
    }
  });
});

describe('the invariant is live: it reports what it is meant to', () => {
  it('names an item that cites nothing when the allow-list is empty', async () => {
    const problems = await auditRecommendations(h, TWO, { allowList: {} });
    expect(problems.sort()).toEqual(
      Object.keys(EVIDENCE_FREE)
        .map((key) => `cites nothing and is not allowed to: ${key}`)
        .sort(),
    );
  });

  it('names an allow-list entry that is no longer true', async () => {
    const stale = { ...EVIDENCE_FREE, 'CG-SYN-1002:sub-check:evidence_integrity/EI-1': 'x' };
    expect(await auditRecommendations(h, TWO, { allowList: stale })).toEqual([
      'allow-listed but not empty (or gone): CG-SYN-1002:sub-check:evidence_integrity/EI-1',
    ]);
  });

  it('names a link that leads nowhere, in the whole record and in a window', async () => {
    const asOf = eventBySuffix(oneEvents, 'e07').timestamp;
    for (const when of [undefined, asOf]) {
      const { unresolved } = await resolveAll(
        h,
        ONE,
        [
          { type: 'claim', id: 'clm_fabricated' },
          { type: 'requirement', id: 'req.fabricated' },
        ],
        when,
      );
      expect(unresolved.map((u) => `${u.link.type}:${u.reason}`)).toEqual([
        'claim:not_found',
        'requirement:not_found',
      ]);
    }
  });
});

describe('in an earlier window, what a recommendation cites is known by then', () => {
  it('Case One: quality, warnings and metrics at four moments of the case', async () => {
    for (const suffix of AS_OF_SUFFIXES) {
      const asOf = eventBySuffix(oneEvents, suffix).timestamp;
      expect(await auditRecommendations(h, ONE, { asOf }), `${suffix} (${asOf})`).toEqual([]);
    }
  }, 180_000);

  it('Case Two: at its first message and in the middle of the case', async () => {
    for (const event of [twoEvents[0], twoEvents[Math.floor(twoEvents.length / 2)]]) {
      const asOf = event?.timestamp ?? '';
      expect(await auditRecommendations(h, TWO, { asOf }), asOf).toEqual([]);
    }
  }, 120_000);
});
