import {
  CoachingReportSchema,
  type CaseWarning,
  type CoachingReport,
  type EvidenceLink,
  type MetricEstimate,
  type QualityAssessment,
} from '@caseguard/schemas';
import { CONTOSO, PERSONAS, type Harness, type Json } from './support/app-harness';

/*
 * Support for the evidence-link invariant: collect everything the product recommends or finds for a case
 * (sub-checks, penalties, improvements, warnings, coaching), resolve every link it cites through the
 * `provenance.resolve` route, and say what does not hold.
 */

const API = '/api/v1';

export type RecommendationKind = 'sub-check' | 'penalty' | 'improvement' | 'warning' | 'coaching';

/** One thing the product tells a person to do or to look at, with what it cites. */
export interface Recommendation {
  readonly kind: RecommendationKind;
  /** Stable within a case, so that an allow-list entry can name it. */
  readonly id: string;
  readonly label: string;
  readonly links: readonly EvidenceLink[];
}

/**
 * Items that cite nothing on purpose, each with the reason. A key is `<case reference>:<kind>:<id>`.
 *
 * Nothing here is a gap to be closed later. Each is either a check that passes only because something
 * did not happen (there is no message to quote for an absence), a check that does not apply to the case,
 * or advice that is not about anything in this case. Anything else the engine can point at, it points at:
 * a pass with something to show (a statement backed by evidence, a message that set expectations, the
 * requirements that were met) cites it.
 */
export const EVIDENCE_FREE: Readonly<Record<string, string>> = {
  'CG-SYN-1002:sub-check:evidence_integrity/EI-2':
    'Passes by an absence: no working hypothesis was kept after the evidence on record had turned against it. There is no message to quote for something that did not happen.',
  'CG-SYN-1002:sub-check:diagnostic_reasoning/DR-2':
    'Passes by an absence: no statement about the cause kept a hypothesis the evidence had already turned against. Nothing happened that could be cited.',
  'CG-SYN-1002:sub-check:scoping_completeness/SC-3':
    'Does not apply: the case was never escalated, so there is no escalation whose evidence could be checked. It has no weight in the score.',
  'CG-SYN-1002:sub-check:customer_communication/CC-4':
    'Passes by an absence: the customer never had to ask for an update. There is no message to quote for a request that was never made.',
  'CG-SYN-1002:coaching:recommendedNextAction':
    'General guidance ("share what worked") offered because a closed case has no decision point to improve. It is not about anything in this case, so there is nothing to cite.',
};

const get = async (h: Harness, url: string): Promise<Json> => {
  const res = await h.call(PERSONAS.admin, { method: 'GET', url: `${API}${url}` });
  if (res.statusCode !== 200) throw new Error(`GET ${url}: HTTP ${res.statusCode}`);
  return res.data;
};

const query = (asOf: string | undefined, extra = ''): string =>
  [extra, asOf === undefined ? '' : `asOf=${encodeURIComponent(asOf)}`]
    .filter((part) => part !== '')
    .join('&');

export interface RecommendationsOfCase {
  readonly reference: string;
  readonly items: Recommendation[];
  /** Links of metric contributors: they have to resolve, but a metric need not cite anything. */
  readonly metricLinks: EvidenceLink[];
}

/** Everything cited by the recommendations of a case, in the whole record or in a window. */
export async function recommendationsOf(
  h: Harness,
  caseId: string,
  asOf?: string,
): Promise<RecommendationsOfCase> {
  const q = (extra = '') => (query(asOf, extra) === '' ? '' : `?${query(asOf, extra)}`);
  const [detail, quality, warnings, metrics] = (await Promise.all([
    get(h, `/cases/${caseId}`),
    get(h, `/cases/${caseId}/quality${q()}`),
    get(h, `/cases/${caseId}/warnings${q('state=all')}`),
    get(h, `/cases/${caseId}/metrics${q()}`),
  ])) as [Json, QualityAssessment, { items: CaseWarning[] }, { items: MetricEstimate[] }];
  const items: Recommendation[] = [];

  for (const dimension of quality.dimensions) {
    for (const check of dimension.subChecks) {
      items.push({
        kind: 'sub-check',
        id: `${dimension.key}/${check.id}`,
        label: check.label,
        links: check.evidence,
      });
    }
  }
  for (const penalty of quality.penalties) {
    items.push({ kind: 'penalty', id: penalty.key, label: penalty.label, links: penalty.evidence });
  }
  for (const improvement of quality.improvements) {
    items.push({
      kind: 'improvement',
      id: improvement.title,
      label: improvement.title,
      links: improvement.evidence,
    });
  }
  for (const warning of warnings.items) {
    items.push({
      kind: 'warning',
      id: `${warning.ruleId}/${warning.fingerprint}`,
      label: warning.title,
      links: warning.evidence,
    });
  }
  // The coaching report is a retrospective of the finished case: it has no window.
  if (asOf === undefined) {
    const coaching: CoachingReport = CoachingReportSchema.parse(
      await get(h, `/cases/${caseId}/coaching`),
    );
    const sections: [string, readonly (typeof coaching.wentWell)[number][]][] = [
      ['wentWell', coaching.wentWell],
      ['missedOpportunity', coaching.missedOpportunity ? [coaching.missedOpportunity] : []],
      ['evidenceQuality', coaching.evidenceQuality],
      ['reasoningImprovements', coaching.reasoningImprovements],
      ['communicationImprovements', coaching.communicationImprovements],
      ['customerEffortImprovements', coaching.customerEffortImprovements],
      [
        'recommendedNextAction',
        coaching.recommendedNextAction ? [coaching.recommendedNextAction] : [],
      ],
    ];
    for (const [section, list] of sections) {
      list.forEach((item, index) => {
        items.push({
          kind: 'coaching',
          id: list.length > 1 ? `${section}[${index}]` : section,
          label: item.title,
          links: item.evidence,
        });
      });
    }
  }

  const metricLinks = metrics.items.flatMap((metric) => [
    ...metric.contributors.flatMap((contributor) => contributor.evidence),
    ...(metric.ase?.components ?? []).flatMap((component) => component.evidence),
  ]);
  return { reference: (detail as { reference: string }).reference, items, metricLinks };
}

/** Everything a request for these links answers, over as many requests as the limit needs. */
export async function resolveAll(
  h: Harness,
  caseId: string,
  links: readonly EvidenceLink[],
  asOf?: string,
): Promise<{ items: Json[]; unresolved: Json[] }> {
  const distinct = [...new Set(links.map((link) => `${link.type}:${link.id}`))];
  const items: Json[] = [];
  const unresolved: Json[] = [];
  for (let i = 0; i < distinct.length; i += 40) {
    const batch = distinct.slice(i, i + 40).join(',');
    const answer = await get(
      h,
      `/cases/${caseId}/provenance?links=${encodeURIComponent(batch)}${asOf === undefined ? '' : `&asOf=${encodeURIComponent(asOf)}`}`,
    );
    items.push(...(answer.items as Json[]));
    unresolved.push(...(answer.unresolved as Json[]));
  }
  return { items, unresolved };
}

/**
 * The evidence and claims that were found in the text of a message (a pattern, a rule over a sentence),
 * as `type:id`. A structured value and a derived statement are not in it: they have no text to quote.
 */
async function quotedRecords(h: Harness, caseId: string): Promise<Set<string>> {
  const repos = h.repos(CONTOSO);
  const quoted = new Set<string>();
  for (const evidence of await repos.analysis.listEvidence(caseId)) {
    if (evidence.method !== 'structured') quoted.add(`evidence:${evidence.id}`);
  }
  let cursor: string | undefined;
  do {
    const page = await repos.analysis.listClaims(caseId, { limit: 200, cursor });
    for (const claim of page.items) {
      const found = claim.method !== 'derived' && claim.method !== 'structured';
      if (found && claim.sourceRef !== null) quoted.add(`claim:${claim.id}`);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return quoted;
}

/**
 * What does not hold for a case: an item that cites nothing without being on the allow-list, an
 * allow-list entry that no longer matches an empty item, a link that does not resolve, and a citation of
 * text that is not verified (or a verified one that has nothing to show).
 */
export async function auditRecommendations(
  h: Harness,
  caseId: string,
  options: { allowList?: Readonly<Record<string, string>>; asOf?: string } = {},
): Promise<string[]> {
  const allowList = options.allowList ?? EVIDENCE_FREE;
  const { reference, items, metricLinks } = await recommendationsOf(h, caseId, options.asOf);
  const problems: string[] = [];

  if (options.asOf === undefined) {
    const empty = new Set<string>();
    for (const item of items) {
      const key = `${reference}:${item.kind}:${item.id}`;
      if (item.links.length > 0) continue;
      empty.add(key);
      if (allowList[key] === undefined)
        problems.push(`cites nothing and is not allowed to: ${key}`);
    }
    for (const key of Object.keys(allowList)) {
      if (key.startsWith(`${reference}:`) && !empty.has(key)) {
        problems.push(`allow-listed but not empty (or gone): ${key}`);
      }
    }
  }

  const cited = [...items.flatMap((item) => item.links), ...metricLinks];
  const { items: resolved, unresolved } = await resolveAll(h, caseId, cited, options.asOf);
  for (const u of unresolved) {
    problems.push(`does not resolve (${u.reason}): ${u.link.type}:${u.link.id}`);
  }
  const quoted = await quotedRecords(h, caseId);
  for (const item of resolved) {
    const source = item.source;
    const label = `${item.link.type}:${item.link.id}`;
    if (quoted.has(label) && source?.verification !== 'verified') {
      problems.push(`a citation of text is not verified: ${label}`);
    }
    if (source === null) continue;
    if (source.verification === 'mismatch')
      problems.push(`excerpt does not match the text: ${label}`);
    if ((source.field !== null) !== (source.verification === 'verified')) {
      problems.push(`a located citation is not verified, or an unlocated one is: ${label}`);
    }
    if (source.verification === 'verified' && source.context === null) {
      problems.push(`verified but nothing to show: ${label}`);
    }
  }
  return problems;
}
