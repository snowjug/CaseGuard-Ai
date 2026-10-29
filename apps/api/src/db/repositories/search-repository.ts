import { SearchResultSchema } from '@caseguard/schemas';
import { z } from 'zod';
import { cleanText, clipText, parseStored, validateInput, type RepoContext } from './support';
import type { SearchHit, SearchHitType, SearchRepository } from './types';

/** Largest result list a caller may ask for. */
export const MAX_SEARCH_RESULTS = 100;
/** Longer search text is cut to this: nothing useful is looked for beyond it. */
export const MAX_SEARCH_TEXT_CHARS = 200;
/** Same limit as `SearchResultSchema.snippet`. */
export const MAX_SNIPPET_CHARS = 300;
const MAX_TITLE_CHARS = 160;
const MAX_CLAIM_TITLE_CHARS = 100;
/** Characters of a body handed to ts_headline (the index itself covers more). */
const HEADLINE_SOURCE_CHARS = 30_000;

/**
 * How the score is built. Inside one table `ts_rank` weighs where the words were found: title and
 * reference (A) > label, tag or key (B) > body (C), see migration 0007. `ts_rank` is normalised to
 * [0, 1) and multiplied by the weight below, which puts the main objects (cases, skills,
 * hypotheses) ahead of text found inside them (warnings, claims, events).
 */
export const SEARCH_TYPE_WEIGHTS: Readonly<Record<SearchHitType, number>> = {
  case: 1,
  skill: 0.9,
  hypothesis: 0.85,
  warning: 0.8,
  claim: 0.7,
  event: 0.6,
};

/**
 * Empty quoted delimiters make ts_headline return plain text: no markup is ever added, so there is
 * nothing to strip afterwards. (Unquoted empty values are misparsed and leave stray commas.)
 */
const HEADLINE_OPTIONS = 'StartSel="", StopSel="", MaxWords=30, MinWords=12, ShortWord=3';

function weighted(alias: string, type: SearchHitType): string {
  return `(ts_rank(${alias}.search_tsv, (SELECT rank_tsq FROM q), 32)::float8 * ${SEARCH_TYPE_WEIGHTS[type]}::float8)`;
}

/**
 * One statement for every type. $1 = tenant, $2 = the user's text, $3 = limit; the text only ever
 * travels as a bind parameter. `q` parses it with web-search syntax and is empty (so nothing is
 * scanned) when the text has no searchable words or only exclusions (`-word`), for which
 * `querytree` returns 'T'. `tsq` matches; `rank_tsq` is `tsq` without its exclusions, because
 * `ts_rank` scores an AND query that contains a NOT as roughly zero. The branches read them through
 * uncorrelated scalar subqueries, which PostgreSQL evaluates once and can use as GIN index
 * conditions. Each branch keeps its own top `limit` rows, the outer query merges them and only then
 * builds snippets, so ts_headline runs for at most `limit` rows.
 * Exported for the test that proves the GIN indexes serve this statement.
 */
export const SEARCH_SQL = `
WITH q AS (
  SELECT parsed.tsq, querytree(parsed.tsq)::tsquery AS rank_tsq
    FROM (SELECT websearch_to_tsquery('english', $2::text) AS tsq) AS parsed
   WHERE querytree(parsed.tsq) <> 'T'
), hits AS (
  (SELECT 'case'::text AS type, c.id AS id, c.id AS case_id, c.title AS title,
          concat_ws(' · ', nullif(c.reference, ''), nullif(array_to_string(c.tags, ', '), '')) AS detail,
          NULL::text AS alias, NULL::text AS kind, ${weighted('c', 'case')} AS score
     FROM cases c
    WHERE c.tenant_id = $1 AND c.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY score DESC, c.id
    LIMIT $3::integer)
  UNION ALL
  (SELECT 'skill'::text, s.id, NULL::text, s.name,
          left(coalesce(s.data ->> 'description', ''), ${HEADLINE_SOURCE_CHARS}),
          NULL::text, NULL::text, ${weighted('s', 'skill')}
     FROM skills s
    WHERE s.tenant_id = $1 AND s.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY 8 DESC, s.id
    LIMIT $3::integer)
  UNION ALL
  (SELECT 'hypothesis'::text, h.id, h.case_id, h.name,
          left(coalesce(h.data ->> 'description', ''), ${HEADLINE_SOURCE_CHARS}),
          NULL::text, NULL::text, ${weighted('h', 'hypothesis')}
     FROM hypotheses h
    WHERE h.tenant_id = $1 AND h.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY 8 DESC, h.case_id, h.id
    LIMIT $3::integer)
  UNION ALL
  (SELECT 'warning'::text, w.id, w.case_id, w.data ->> 'title',
          left(coalesce(w.data ->> 'message', ''), ${HEADLINE_SOURCE_CHARS}),
          NULL::text, NULL::text, ${weighted('w', 'warning')}
     FROM case_warnings w
    WHERE w.tenant_id = $1 AND w.state = 'open' AND w.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY 8 DESC, w.case_id, w.id
    LIMIT $3::integer)
  UNION ALL
  (SELECT 'claim'::text, k.id, k.case_id, left(coalesce(k.data ->> 'text', ''), ${MAX_CLAIM_TITLE_CHARS * 2}),
          left(concat_ws(' — ', k.data ->> 'text', k.data ->> 'explanation'), ${HEADLINE_SOURCE_CHARS}),
          NULL::text, NULL::text, ${weighted('k', 'claim')}
     FROM claims k
    WHERE k.tenant_id = $1 AND k.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY 8 DESC, k.case_id, k.id
    LIMIT $3::integer)
  UNION ALL
  (SELECT 'event'::text, e.id, e.case_id, e.data ->> 'title',
          left(coalesce(e.data ->> 'body', ''), ${HEADLINE_SOURCE_CHARS}),
          e.data ->> 'participantAlias', e.type, ${weighted('e', 'event')}
     FROM case_events e
    WHERE e.tenant_id = $1 AND e.search_tsv @@ (SELECT tsq FROM q)
    ORDER BY 8 DESC, e.case_id, e.id
    LIMIT $3::integer)
)
SELECT h.type, h.id, h.case_id, h.title, h.alias, h.kind, h.score,
       ts_headline('english', coalesce(h.detail, ''), (SELECT rank_tsq FROM q), '${HEADLINE_OPTIONS}') AS snippet
  FROM hits h
 ORDER BY h.score DESC, h.type, h.case_id NULLS LAST, h.id
 LIMIT $3::integer`;

const SearchInputSchema = z.object({
  text: z.string(),
  limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS),
});

const SearchHitSchema = SearchResultSchema.omit({ href: true });

interface HitRow {
  type: SearchHitType;
  id: string;
  case_id: string | null;
  title: string | null;
  alias: string | null;
  kind: string | null;
  score: number;
  snippet: string | null;
}

/** The only markup ts_headline emits by default. We configure it away; this is the belt to those braces. */
const HIGHLIGHT_TAGS = /<\/?b>/gi;

function snippetOf(row: HitRow): string {
  return clipText(cleanText((row.snippet ?? '').replace(HIGHLIGHT_TAGS, '')), MAX_SNIPPET_CHARS);
}

function titleOf(row: HitRow): string {
  const own = cleanText(row.title ?? '');
  if (row.type === 'event' && own === '') {
    // Events without a title are named after who said it and what kind of event it was.
    const kind = cleanText((row.kind ?? '').replace(/_/g, ' '));
    const label = [cleanText(row.alias ?? ''), kind].filter((part) => part !== '').join(' · ');
    return clipText(label || `Event ${row.id}`, MAX_TITLE_CHARS);
  }
  const max = row.type === 'claim' ? MAX_CLAIM_TITLE_CHARS : MAX_TITLE_CHARS;
  return clipText(own || `${row.type} ${row.id}`, max);
}

export class SearchRepositoryImpl implements SearchRepository {
  constructor(private readonly ctx: RepoContext) {}

  async query(input: { text: string; limit: number }): Promise<SearchHit[]> {
    const request = validateInput(SearchInputSchema, input, 'search query');
    // Control characters (a NUL cannot be sent to PostgreSQL at all) and runs of blanks are dropped.
    const text = Array.from(cleanText(request.text)).slice(0, MAX_SEARCH_TEXT_CHARS).join('');
    if (text === '') return [];
    return this.ctx.run(async (tx) => {
      const result = await tx.query<HitRow>(SEARCH_SQL, [
        this.ctx.scope.tenantId,
        text,
        request.limit,
      ]);
      return result.rows.map((row) =>
        parseStored(
          SearchHitSchema,
          {
            type: row.type,
            id: row.id,
            caseId: row.case_id,
            title: titleOf(row),
            snippet: snippetOf(row),
            score: Math.round(row.score * 10_000) / 10_000,
          },
          'search hit',
        ),
      );
    });
  }
}
