import { SearchResultSchema, type CaseWarning } from '@caseguard/schemas';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../src/errors';
import { createRepositories } from '../src/db/repositories';
import {
  MAX_SEARCH_RESULTS,
  MAX_SNIPPET_CHARS,
  SEARCH_SQL,
} from '../src/db/repositories/search-repository';
import type { Database, IngestCaseInput, SqlExecutor } from '../src/db/repositories/types';
import {
  CONTOSO_SCOPE,
  FABRIKAM_SCOPE,
  TEST_DATABASE_STARTUP_TIMEOUT_MS,
  createTestRepositories,
  type TestHarness,
} from '../src/db/testing';
import {
  TENANT_A,
  TENANT_B,
  buildCaseEvent,
  buildIngestInput,
  buildSkill,
  buildSkillVersion,
  buildSnapshot,
  buildWarning,
  at,
} from './builders';

const SearchHitSchema = SearchResultSchema.omit({ href: true });

let h: TestHarness;

beforeAll(async () => {
  h = await createTestRepositories();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);
afterAll(async () => {
  await h.close();
});

const contoso = () => h.contoso();
const fabrikam = () => h.fabrikam();

const label = (hit: { type: string; id: string; caseId: string | null }): string =>
  `${hit.type}:${hit.caseId ?? '-'}:${hit.id}`;

type EventText = { title: string | null; body: string };

/** Replaces the generated events (by index) so each test can rely on exact words. */
function withEventText(input: IngestCaseInput, texts: Record<number, EventText>): IngestCaseInput {
  return {
    ...input,
    events: input.events.map((event, index) => {
      const text = texts[index];
      return text ? buildCaseEvent({ ...event, title: text.title, body: text.body }) : event;
    }),
  };
}

async function saveSkill(
  repos: ReturnType<typeof contoso>,
  id: string,
  key: string,
  name: string,
  description: string,
  tenantId = TENANT_A,
): Promise<void> {
  await repos.skills.create({
    skill: buildSkill({ tenantId, id, key, name, description, currentVersionId: `${id}_v1` }),
    version: buildSkillVersion({ tenantId, id: `${id}_v1`, skillId: id }),
  });
}

function warningsFor(caseId: string): CaseWarning[] {
  const common = { tenantId: TENANT_A, caseId, analysisRunId: `run_${caseId}_1` };
  return [
    buildWarning({
      ...common,
      id: `warn_${caseId}_scope`,
      ruleId: 'rule.missing-scope',
      title: 'Quokka scope is unknown',
      message: 'The number of affected users was never confirmed.',
      fingerprint: 'rule.missing-scope:scope',
      rank: 1,
    }),
    buildWarning({
      ...common,
      id: `warn_${caseId}_dismissed`,
      ruleId: 'rule.dismissed',
      title: 'Dismissed quokka warning',
      fingerprint: 'rule.dismissed:x',
      rank: 2,
      state: 'dismissed',
      dismissal: { by: 'user_riley_reviewer', at: at(30), reason: 'Not relevant for this case' },
    }),
    buildWarning({
      ...common,
      id: `warn_${caseId}_resolved`,
      ruleId: 'rule.resolved',
      title: 'Resolved quokka warning',
      fingerprint: 'rule.resolved:x',
      rank: 3,
      state: 'resolved',
      resolvedAt: at(40),
      resolvedReason: 'The scope was confirmed',
    }),
  ];
}

const LONG_CLAIM = `${'A claim that goes on and on. '.repeat(14)}It ends with a narwhal.`;

/** Two Contoso cases (one analysed, with a skill) and one Fabrikam case that shares some words. */
async function seedSearchData(): Promise<void> {
  const inputA = withEventText(
    buildIngestInput({
      caseId: 'case_a',
      reference: 'CG-2026-0042',
      title: 'Quokka proxy authentication failing',
      receivedSeed: 'a',
    }),
    {
      0: {
        title: 'Customer report',
        body: 'The customer says the quokka service stopped answering.',
      },
      1: {
        title: 'Proxy log shows block',
        body: 'The proxy denied connections to login.example.test with HTTP 407 for the whole tenant.',
      },
      2: {
        title: 'TLS inspection error',
        body: 'The proxy log also shows a TLS inspection error for the same host.',
      },
      3: { title: null, body: 'Certificate rotation finished and the chain validates.' },
      4: { title: 'Markup', body: '<b>bold</b> markup about a wombat in the body.' },
      5: { title: 'Wombat', body: 'Unrelated closing note.' },
    },
  );
  inputA.case = { ...inputA.case, tags: ['network', 'marmot'] };
  await contoso().cases.ingest(inputA);
  const snapshot = buildSnapshot(inputA, { warnings: warningsFor('case_a') });
  await contoso().analysis.saveSnapshot({
    ...snapshot,
    claims: snapshot.claims.map((claim, index) => ({
      ...claim,
      text:
        [
          'Users cannot sign in since Monday because of the quokka outage.',
          'The engineer asked for the proxy logs.',
          LONG_CLAIM,
        ][index] ?? claim.text,
    })),
    hypotheses: snapshot.hypotheses.map((hypothesis, index) =>
      index === 0
        ? { ...hypothesis, name: 'Quokka proxy rule blocks the sign-in endpoint' }
        : hypothesis,
    ),
  });
  await saveSkill(
    contoso(),
    'skill_quokka',
    'quokka-signin-triage',
    'Quokka sign-in triage',
    'Synthetic skill: triage sign-in failures.',
  );

  const inputB = withEventText(
    buildIngestInput({
      caseId: 'case_b',
      reference: 'CG-2026-0043',
      title: 'Printer offline in branch office',
      receivedSeed: 'b',
    }),
    {
      0: { title: 'Wombat sighting', body: 'Nothing to see here.' },
      3: {
        title: 'Whitespace',
        body: 'First line.\n\n    Second\tline about a narwhal with   spaces.',
      },
      4: {
        title: 'Long body',
        body: `${'filler '.repeat(400)}zebra stripes are unique ${'filler '.repeat(400)}`,
      },
      5: { title: 'Long token', body: `okapi ${'x'.repeat(2000)}` },
    },
  );
  inputB.case = { ...inputB.case, tags: ['hardware'] };
  await contoso().cases.ingest(inputB);

  const inputZ = withEventText(
    buildIngestInput({
      tenantId: TENANT_B,
      caseId: 'case_z',
      reference: 'CG-9001',
      title: 'Zeppelin hangar sign-in outage and quokka',
      receivedSeed: 'z',
    }),
    { 2: { title: 'Zeppelin note', body: 'The zeppelin hangar proxy was unreachable.' } },
  );
  await fabrikam().cases.ingest(inputZ);
  await fabrikam().analysis.saveSnapshot(buildSnapshot(inputZ));
  await saveSkill(
    fabrikam(),
    'skill_zeppelin',
    'zeppelin-triage',
    'Zeppelin triage',
    'Synthetic skill: triage hangar outages.',
    TENANT_B,
  );
}

describe('[FR-UX-04] global search: what is found and how it is described', () => {
  beforeAll(async () => {
    await h.reset();
    await seedSearchData();
  });

  it('finds every searchable type, best match first, each with its caseId, title and snippet', async () => {
    const hits = await contoso().search.query({ text: 'quokka', limit: 20 });
    expect(hits.map(label)).toEqual([
      'case:case_a:case_a',
      'skill:-:skill_quokka',
      'hypothesis:case_a:hyp_case_a_proxy',
      'warning:case_a:warn_case_a_scope',
      'claim:case_a:clm_case_a_1',
      'event:case_a:evt_01',
    ]);
    expect(hits.map((hit) => hit.title)).toEqual([
      'Quokka proxy authentication failing',
      'Quokka sign-in triage',
      'Quokka proxy rule blocks the sign-in endpoint',
      'Quokka scope is unknown',
      'Users cannot sign in since Monday because of the quokka outage.',
      'Customer report',
    ]);
    for (const hit of hits) {
      expect(SearchHitSchema.safeParse(hit).success).toBe(true);
      expect(hit.snippet.length).toBeGreaterThan(0);
      expect(hit.snippet).not.toMatch(/[<>]/);
    }
    // Scores fall as the field weight (title > label > body) and type weight fall; all within [0, 1).
    const scores = hits.map((hit) => hit.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(scores.every((score) => score > 0 && score < 1)).toBe(true);
    expect(new Set(scores).size).toBe(scores.length);
  });

  it('describes each hit with text taken from where it matched', async () => {
    const byType = Object.fromEntries(
      (await contoso().search.query({ text: 'quokka', limit: 20 })).map((hit) => [hit.type, hit]),
    );
    expect(byType['case']?.snippet).toBe('CG-2026-0042 · network, marmot');
    expect(byType['skill']?.snippet).toBe('Synthetic skill: triage sign-in failures.');
    expect(byType['warning']?.snippet).toBe('The number of affected users was never confirmed.');
    expect(byType['event']?.snippet).toBe(
      'The customer says the quokka service stopped answering.',
    );
    expect(byType['skill']?.caseId).toBeNull();
    expect(byType['case']?.caseId).toBe('case_a');
  });

  it('ranks a title above a body: the same word in an event title beats the same word in a body', async () => {
    const hits = await contoso().search.query({ text: 'wombat', limit: 10 });
    // The word is in the title of case_a/evt_06 and case_b/evt_01 (equal scores, so ordered by case
    // id) and only in the body of case_a/evt_05.
    expect(hits.map(label)).toEqual([
      'event:case_a:evt_06',
      'event:case_b:evt_01',
      'event:case_a:evt_05',
    ]);
    const [first, second, third] = hits;
    expect(first?.score).toBe(second?.score);
    expect(second?.score ?? 0).toBeGreaterThan(third?.score ?? 1);
  });

  it('matches case references exactly or by prefix, in any letter case', async () => {
    expect((await contoso().search.query({ text: 'CG-2026-0042', limit: 5 })).map(label)).toEqual([
      'case:case_a:case_a',
    ]);
    expect((await contoso().search.query({ text: 'cg-2026-0042', limit: 5 })).map(label)).toEqual([
      'case:case_a:case_a',
    ]);
    expect((await contoso().search.query({ text: 'CG-2026', limit: 5 })).map(label)).toEqual([
      'case:case_a:case_a',
      'case:case_b:case_b',
    ]);
  });

  it('understands web-search syntax: stemming, phrases, OR and exclusion', async () => {
    // Stemming: "authenticate" finds "authentication", "failed" finds "failing".
    expect((await contoso().search.query({ text: 'authenticate', limit: 5 })).map(label)).toContain(
      'case:case_a:case_a',
    );
    expect((await contoso().search.query({ text: 'failed', limit: 5 })).map(label)).toContain(
      'case:case_a:case_a',
    );

    const phrase = await contoso().search.query({ text: '"denied connections"', limit: 5 });
    expect(phrase.map(label)).toEqual(['event:case_a:evt_02']);
    expect(await contoso().search.query({ text: '"connections denied"', limit: 5 })).toEqual([]);

    const either = await contoso().search.query({ text: 'marmot or narwhal', limit: 10 });
    expect(either.map(label)).toEqual(
      expect.arrayContaining([
        'case:case_a:case_a',
        'event:case_b:evt_04',
        'claim:case_a:clm_case_a_3',
      ]),
    );

    const proxy = (await contoso().search.query({ text: 'proxy', limit: 20 })).map(label);
    expect(proxy).toEqual(expect.arrayContaining(['event:case_a:evt_02', 'event:case_a:evt_03']));
    const withoutTls = await contoso().search.query({ text: 'proxy -tls', limit: 20 });
    expect(withoutTls.map(label)).toContain('event:case_a:evt_02');
    expect(withoutTls.map(label)).not.toContain('event:case_a:evt_03');
    // An exclusion must not zero the score: it is ranked on the words that were asked for.
    expect(withoutTls.every((hit) => hit.score > 0.01)).toBe(true);
    expect(withoutTls.map((hit) => hit.score)).toEqual(
      (await contoso().search.query({ text: 'proxy', limit: 20 }))
        .filter((hit) => withoutTls.some((kept) => label(kept) === label(hit)))
        .map((hit) => hit.score),
    );
  });

  it('returns nothing for blank text, stop words, punctuation or exclusions only', async () => {
    for (const text of [
      '',
      '   ',
      '\n\t',
      'the',
      'and of',
      '%_!',
      '-tls',
      '-proxy -tls',
      '"" ""',
    ]) {
      expect(await contoso().search.query({ text, limit: 10 })).toEqual([]);
    }
  });

  it('only open warnings are searchable', async () => {
    const warnings = (await contoso().search.query({ text: 'quokka warning', limit: 10 })).filter(
      (hit) => hit.type === 'warning',
    );
    expect(warnings).toEqual([]);
    const open = (await contoso().search.query({ text: 'quokka scope', limit: 10 })).filter(
      (hit) => hit.type === 'warning',
    );
    expect(open.map((hit) => hit.id)).toEqual(['warn_case_a_scope']);
    expect(
      (await contoso().search.query({ text: 'dismissed OR resolved', limit: 10 })).filter(
        (hit) => hit.type === 'warning',
      ),
    ).toEqual([]);
  });

  it('is deterministic: the same query returns the same hits in the same order', async () => {
    const first = await contoso().search.query({ text: 'synthetic', limit: 50 });
    const second = await contoso().search.query({ text: 'synthetic', limit: 50 });
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(5);
    // Equal scores are ordered by type, then case id, then id.
    for (let index = 1; index < first.length; index += 1) {
      const previous = first[index - 1];
      const current = first[index];
      if (!previous || !current || previous.score !== current.score) continue;
      const key = (hit: typeof current) => [hit.type, hit.caseId ?? '', hit.id].join('\u0000');
      expect(key(previous) <= key(current)).toBe(true);
    }
  });
});

describe('[FR-UX-04] global search: snippets and titles are plain, short text', () => {
  it('never exceeds 300 characters and shows the part of a long body that matched', async () => {
    const [hit] = await contoso().search.query({ text: 'zebra', limit: 5 });
    expect(hit?.type).toBe('event');
    expect(hit?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit?.snippet).toContain('zebra stripes are unique');
    expect(hit?.snippet).not.toMatch(/<\/?b>/);
  });

  it('clips a snippet made of one enormous word and marks the cut', async () => {
    const [hit] = await contoso().search.query({ text: 'okapi', limit: 5 });
    expect(hit?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
    expect(hit?.snippet.startsWith('okapi xxx')).toBe(true);
    expect(hit?.snippet.endsWith('…')).toBe(true);
  });

  it('adds no highlight markup and removes literal <b> tags from the text it quotes', async () => {
    const hits = await contoso().search.query({ text: 'markup', limit: 5 });
    expect(hits.map(label)).toEqual(['event:case_a:evt_05']);
    expect(hits[0]?.snippet).toBe('bold markup about a wombat in the body.');
    for (const hit of await contoso().search.query({ text: 'proxy', limit: 50 })) {
      expect(hit.snippet).not.toMatch(/<\/?b>/i);
      expect(hit.snippet).not.toContain('\u0000');
    }
  });

  it('collapses line breaks, tabs and runs of spaces', async () => {
    const hits = await contoso().search.query({ text: 'narwhal', limit: 5 });
    const event = hits.find((hit) => hit.type === 'event');
    expect(event?.snippet).toBe('First line. Second line about a narwhal with spaces.');
  });

  it('names an event without a title after who wrote it and what kind of event it was', async () => {
    const [hit] = await contoso().search.query({ text: 'certificate rotation', limit: 5 });
    expect(hit?.type).toBe('event');
    expect(hit?.title).toBe('System · diagnostic result');
  });

  it('shortens the title of a long claim to 100 characters, keeping the match in the snippet', async () => {
    const hits = await contoso().search.query({ text: 'narwhal', limit: 5 });
    const claim = hits.find((hit) => hit.type === 'claim');
    expect(claim?.title.length).toBeLessThanOrEqual(100);
    expect(claim?.title.endsWith('…')).toBe(true);
    expect(claim?.snippet).toContain('narwhal');
    expect(claim?.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS);
  });
});

describe('[FR-UX-04] global search: any input is safe and never reaches SQL as text', () => {
  const HOSTILE = [
    "'; DROP TABLE cases; --",
    '" OR 1=1 --',
    "quokka') OR ('1'='1",
    'quokka; SELECT pg_sleep(10)',
    '\\',
    '\\\\ \\\' \\"',
    '%',
    '_',
    '%quokka%',
    'quokka:*',
    ':*',
    '& | ! <-> ( ) <2>',
    '((((((((((',
    '))))',
    '"""',
    "'''",
    '$1 $2 $3 ${jndi:ldap://x}',
    '/* quokka */',
    '{"a":[1,2]}',
    '<script>alert(1)</script>',
    'quokka\u0000proxy',
    '\u202e quokka',
    '\u{1F984} \u{1F4A5}',
    'العربية quokka',
    'x'.repeat(5000),
    'quokka '.repeat(2000),
  ];

  it.each(HOSTILE.map((text, index) => [index, text.slice(0, 40)] as const))(
    'input #%i (%s) neither throws nor damages anything',
    async (index) => {
      const text = HOSTILE[index] ?? '';
      const hits = await contoso().search.query({ text, limit: 10 });
      expect(Array.isArray(hits)).toBe(true);
      for (const hit of hits) expect(SearchHitSchema.safeParse(hit).success).toBe(true);
      const cases = await h.database.query<{ n: number }>('SELECT count(*)::int AS n FROM cases');
      expect(cases.rows[0]?.n).toBe(3);
    },
  );

  it('the text travels only as a bind parameter, in one statement', async () => {
    const statements: { text: string; params: readonly unknown[] | undefined }[] = [];
    const spy = (tx: SqlExecutor): SqlExecutor => ({
      query: (text, params) => {
        statements.push({ text, params });
        return tx.query(text, params);
      },
    });
    const recording: Database = {
      kind: h.database.kind,
      query: (text, params) => spy(h.database).query(text, params),
      transaction: (fn) => h.database.transaction((tx) => fn(spy(tx))),
      withTenant: (scope, fn) => h.database.withTenant(scope, (tx) => fn(spy(tx))),
      ping: () => h.database.ping(),
      close: () => Promise.resolve(),
    };
    const repos = createRepositories(recording).forTenant(CONTOSO_SCOPE);

    const needle = "needle'; DROP TABLE cases; --";
    await repos.search.query({ text: needle, limit: 3 });
    const search = statements.filter((statement) =>
      statement.text.includes('websearch_to_tsquery'),
    );
    expect(search).toHaveLength(1);
    expect(search[0]?.text).toBe(SEARCH_SQL);
    expect(search[0]?.text).not.toContain('needle');
    expect(search[0]?.text).not.toContain('DROP');
    expect(search[0]?.params).toEqual([TENANT_A, needle, 3]);
    expect(statements.every((statement) => !statement.text.includes('needle'))).toBe(true);
  });

  it('cleans control characters, cuts overlong text and skips the database for blank text', async () => {
    const statements: unknown[][] = [];
    const recording: Database = {
      kind: h.database.kind,
      query: (text, params) => h.database.query(text, params),
      transaction: (fn) => h.database.transaction(fn),
      withTenant: (scope, fn) =>
        h.database.withTenant(scope, (tx) =>
          fn({
            query: (text, params) => {
              statements.push([text, params]);
              return tx.query(text, params);
            },
          }),
        ),
      ping: () => h.database.ping(),
      close: () => Promise.resolve(),
    };
    const repos = createRepositories(recording).forTenant(CONTOSO_SCOPE);

    expect(await repos.search.query({ text: ' \n\t\u0000 ', limit: 5 })).toEqual([]);
    expect(statements.filter((s) => String(s[0]).includes('websearch'))).toHaveLength(0);

    await repos.search.query({ text: 'quokka\u0000\u0001  proxy', limit: 5 });
    await repos.search.query({ text: 'a'.repeat(1000), limit: 5 });
    const params = statements
      .filter((s) => String(s[0]).includes('websearch'))
      .map((s) => (s[1] as unknown[])[1] as string);
    expect(params[0]).toBe('quokka proxy');
    expect(params[1]).toHaveLength(200);
  });

  it.each([
    ['limit 0', { text: 'quokka', limit: 0 }],
    ['a negative limit', { text: 'quokka', limit: -1 }],
    ['a fractional limit', { text: 'quokka', limit: 2.5 }],
    [`a limit over ${MAX_SEARCH_RESULTS}`, { text: 'quokka', limit: MAX_SEARCH_RESULTS + 1 }],
    ['NaN as the limit', { text: 'quokka', limit: Number.NaN }],
    ['a string as the limit', { text: 'quokka', limit: '5' as unknown as number }],
    ['a missing text', { limit: 5 } as unknown as { text: string; limit: number }],
    ['a numeric text', { text: 42 as unknown as string, limit: 5 }],
  ])('rejects %s with a validation error', async (_label, input) => {
    await expect(contoso().search.query(input)).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('[NFR-SEC-01] global search never crosses tenants', () => {
  it("returns only the calling tenant's rows for a word both tenants use", async () => {
    const mine = await contoso().search.query({ text: 'quokka', limit: 50 });
    const theirs = await fabrikam().search.query({ text: 'quokka', limit: 50 });
    expect(mine.map(label)).not.toContain('case:case_z:case_z');
    expect(theirs.map(label)).toEqual(['case:case_z:case_z']);
    expect(mine.length).toBeGreaterThan(1);

    const synthetic = await fabrikam().search.query({ text: 'synthetic', limit: 100 });
    expect(synthetic.length).toBeGreaterThan(0);
    expect(synthetic.every((hit) => hit.caseId === null || hit.caseId === 'case_z')).toBe(true);
    expect(synthetic.map((hit) => hit.id)).not.toContain('skill_quokka');
  });

  it("a tenant never sees another tenant's unique words, whatever it types", async () => {
    expect(await contoso().search.query({ text: 'zeppelin', limit: 50 })).toEqual([]);
    expect(
      await contoso().search.query({ text: 'hangar OR zeppelin OR CG-9001', limit: 50 }),
    ).toEqual([]);
    expect((await fabrikam().search.query({ text: 'zeppelin', limit: 50 })).length).toBeGreaterThan(
      2,
    );
    expect(
      await fabrikam().search.query({ text: 'wombat OR marmot OR printer', limit: 50 }),
    ).toEqual([]);
    expect(await fabrikam().search.query({ text: 'CG-2026-0042', limit: 50 })).toEqual([]);
  });

  it('row-level security alone confines raw full-text queries, even without a tenant predicate', async () => {
    const tables = ['cases', 'case_events', 'claims', 'hypotheses', 'skills', 'case_warnings'];
    const countSql = (table: string) =>
      `SELECT count(*)::int AS n FROM ${table}
        WHERE search_tsv @@ websearch_to_tsquery('english', 'quokka OR zeppelin OR synthetic')`;

    const asFabrikam = await h.database.withTenant(FABRIKAM_SCOPE, async (tx) => {
      const counts: Record<string, number> = {};
      for (const table of tables)
        counts[table] = (await tx.query<{ n: number }>(countSql(table))).rows[0]?.n ?? -1;
      const ids = (
        await tx.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM case_events WHERE search_tsv @@ websearch_to_tsquery('english', 'synthetic')",
        )
      ).rows.map((row) => row.tenant_id);
      return { counts, ids };
    });
    expect(asFabrikam.ids).toEqual([TENANT_B]);
    expect(asFabrikam.counts['cases']).toBe(1);
    expect(asFabrikam.counts['skills']).toBe(1);

    // With no tenant setting at all the application role sees nothing.
    const withoutTenant = await h.database.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE caseguard_app');
      const counts: number[] = [];
      for (const table of tables)
        counts.push((await tx.query<{ n: number }>(countSql(table))).rows[0]?.n ?? -1);
      return counts;
    });
    expect(withoutTenant).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('searches inside a transaction opened on the tenant repositories', async () => {
    const hits = await contoso().transaction((repos) =>
      repos.search.query({ text: 'quokka', limit: 3 }),
    );
    expect(hits.map(label)).toEqual([
      'case:case_a:case_a',
      'skill:-:skill_quokka',
      'hypothesis:case_a:hyp_case_a_proxy',
    ]);
  });
});

describe('[FR-UX-04] global search: the indexes behind it', () => {
  /** Carries an EXPLAIN plan out of a transaction that has to be rolled back (it drops indexes). */
  class CapturedPlan extends Error {
    constructor(readonly plan: string) {
      super('plan captured; rolling the transaction back');
    }
  }

  const INDEXES: [table: string, index: string, predicate: string][] = [
    ['cases', 'cases_search_idx', ''],
    ['case_events', 'case_events_search_idx', ''],
    ['claims', 'claims_search_idx', ''],
    ['hypotheses', 'hypotheses_search_idx', ''],
    ['skills', 'skills_search_idx', ''],
    ['case_warnings', 'case_warnings_search_idx', "state = 'open' AND "],
  ];

  it('every searched table has a GIN index on its search vector (warnings: open ones only)', async () => {
    const result = await h.database.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%\\_search\\_idx'",
    );
    const defs = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
    for (const [table, index] of INDEXES) {
      expect(defs.get(index), index).toMatch(
        new RegExp(`ON .*${table} USING gin \\(search_tsv\\)`),
      );
    }
    expect(defs.get('case_warnings_search_idx')).toMatch(/WHERE \(state = 'open'/);
  });

  it('the generated search vectors carry the field weights (A title, B tags, C body)', async () => {
    const vector = async (sql: string) =>
      (await h.database.query<{ v: string }>(sql)).rows[0]?.v ?? '';
    const caseVector = await vector("SELECT search_tsv::text AS v FROM cases WHERE id = 'case_a'");
    expect(caseVector).toMatch(/'quokka':1A/);
    expect(caseVector).toMatch(/'0042':\d+A|'-0042':\d+A/);
    expect(caseVector).toMatch(/'marmot':\d+B/);
    const eventVector = await vector(
      "SELECT search_tsv::text AS v FROM case_events WHERE case_id = 'case_a' AND id = 'evt_02'",
    );
    expect(eventVector).toMatch(/'block':\d+A/);
    expect(eventVector).toMatch(/'deni':\d+C/);
  });

  it.each(INDEXES)(
    'the %s index can serve the statement shape used by the search (%s)',
    async (table, index, predicate) => {
      // Sequential and plain index scans are switched off, and every other non-unique index of the
      // table is dropped inside a transaction that is rolled back, so only the GIN index is left to
      // answer the full-text condition (the open-item index of migration 0008 would otherwise be a
      // valid, cheaper way to read the open warnings of a tiny table). For the application role
      // PostgreSQL will not use it while row-level security applies: `@@` is not leakproof (0007).
      const plan = await h.database
        .transaction(async (tx) => {
          await tx.query('SET LOCAL enable_seqscan = off');
          await tx.query('SET LOCAL enable_indexscan = off');
          const others = await tx.query<{ name: string }>(
            `SELECT c.relname AS name
               FROM pg_index x
               JOIN pg_class c ON c.oid = x.indexrelid
              WHERE x.indrelid = $1::regclass AND c.relname <> $2
                AND NOT x.indisunique AND NOT x.indisprimary`,
            [table, index],
          );
          for (const other of others.rows) await tx.query(`DROP INDEX ${other.name}`);
          const result = await tx.query<Record<string, string>>(
            `EXPLAIN WITH q AS (SELECT websearch_to_tsquery('english', 'quokka') AS tsq)
             SELECT 1 FROM ${table} WHERE ${predicate}search_tsv @@ (SELECT tsq FROM q)`,
          );
          throw new CapturedPlan(result.rows.map((row) => Object.values(row)[0]).join('\n'));
        })
        .then(
          () => {
            throw new Error('The transaction was expected to roll back');
          },
          (error: unknown) => {
            if (error instanceof CapturedPlan) return error.plan;
            throw error;
          },
        );
      expect(plan).toContain(`Bitmap Index Scan on ${index}`);
      // The rollback left the schema as it was.
      const left = await h.database.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = $1',
        [table],
      );
      expect(left.rows[0]?.n).toBeGreaterThan(1);
    },
  );
});

describe('[FR-UX-04] global search follows the data', () => {
  beforeEach(async () => {
    await h.reset();
    h.clock.set('2026-01-15T09:00:00.000Z');
  });

  it('shows new content at once, drops what a re-analysis replaced and forgets erased cases', async () => {
    const input = buildIngestInput({
      caseId: 'case_live',
      title: 'Lifecycle case',
      receivedSeed: 'l',
    });
    await contoso().cases.ingest(input);
    expect(await contoso().search.query({ text: 'lifecycle', limit: 5 })).toHaveLength(1);

    const snapshotWithClaim = (text: string, runId: string) => {
      const snapshot = buildSnapshot(input, { runId });
      return {
        ...snapshot,
        claims: snapshot.claims.map((claim, index) => (index === 0 ? { ...claim, text } : claim)),
      };
    };
    await contoso().analysis.saveSnapshot(
      snapshotWithClaim('The platypus is mentioned here.', 'run_case_live_1'),
    );
    expect((await contoso().search.query({ text: 'platypus', limit: 5 })).map(label)).toEqual([
      'claim:case_live:clm_case_live_1',
    ]);

    // A re-analysis replaces the claims: the old words disappear and the new ones are found.
    await contoso().analysis.saveSnapshot(
      snapshotWithClaim('The echidna is mentioned here.', 'run_case_live_2'),
    );
    expect(await contoso().search.query({ text: 'platypus', limit: 5 })).toEqual([]);
    expect((await contoso().search.query({ text: 'echidna', limit: 5 })).map(label)).toEqual([
      'claim:case_live:clm_case_live_1',
    ]);

    expect(await contoso().cases.delete('case_live')).toBe(true);
    expect(
      await contoso().search.query({ text: 'lifecycle OR echidna OR synthetic', limit: 50 }),
    ).toEqual([]);
  });

  it('a dismissed warning leaves the results immediately', async () => {
    const input = buildIngestInput({ caseId: 'case_warn', receivedSeed: 'w' });
    await contoso().cases.ingest(input);
    const warnings = warningsFor('case_warn');
    await contoso().analysis.saveSnapshot(buildSnapshot(input, { warnings }));
    const found = (await contoso().search.query({ text: 'quokka scope', limit: 5 })).map(label);
    expect(found).toEqual(['warning:case_warn:warn_case_warn_scope']);

    await contoso().analysis.dismissWarning('case_warn', 'warn_case_warn_scope', {
      by: 'user_riley_reviewer',
      at: '2026-01-15T10:00:00.000Z',
      reason: 'Confirmed with the customer',
      expectedVersion: 1,
    });
    expect(await contoso().search.query({ text: 'quokka scope', limit: 5 })).toEqual([]);
  });

  it('respects the limit, across and within types, and returns the best hits', async () => {
    const input = withEventText(
      buildIngestInput({
        caseId: 'case_many',
        title: 'Many events',
        eventCount: 12,
        receivedSeed: 'm',
      }),
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          index,
          { title: `Platypus event ${index + 1}`, body: `Platypus body ${index + 1}.` },
        ]),
      ),
    );
    await contoso().cases.ingest(input);
    await saveSkill(
      contoso(),
      'skill_platypus',
      'platypus-skill',
      'Platypus skill',
      'A platypus guide.',
    );

    const all = await contoso().search.query({ text: 'platypus', limit: MAX_SEARCH_RESULTS });
    expect(all).toHaveLength(13);
    expect(all[0]?.type).toBe('skill');
    for (const limit of [1, 2, 5, 12]) {
      const page = await contoso().search.query({ text: 'platypus', limit });
      expect(page).toHaveLength(limit);
      expect(page).toEqual(all.slice(0, limit));
    }
  });

  it('keeps ingesting when an event body is too large to index completely', async () => {
    const huge = `earlyword ${Array.from({ length: 200_000 }, (_, index) => `w${index}`).join(' ')}`;
    const input = withEventText(buildIngestInput({ caseId: 'case_huge', receivedSeed: 'h' }), {
      1: { title: 'Huge body', body: huge },
    });
    await expect(contoso().cases.ingest(input)).resolves.toMatchObject({ created: true });
    expect((await contoso().search.query({ text: 'earlyword', limit: 5 })).map(label)).toEqual([
      'event:case_huge:evt_02',
    ]);
    // Only the first 100,000 characters of a body are indexed (migration 0007).
    expect(await contoso().search.query({ text: 'w199999', limit: 5 })).toEqual([]);
  });
});
