import { verifyExcerpt, type DeterministicAnalysis, type ExcerptCheck } from '@caseguard/domain';
import {
  EVENT_TYPE_LABELS,
  EvidenceLinkSchema,
  IdSchema,
  PROVENANCE_MAX_LINKS,
  type CaseEvent,
  type CaseSource,
  type Claim,
  type CounterfactualScenario,
  type DecisionFork,
  type DiagnosticAction,
  type Evidence,
  type EvidenceLink,
  type Hypothesis,
  type MissingEvidence,
  type ProvenanceItem,
  type ProvenanceResponse,
  type ProvenanceSource,
  type ProvenanceUnresolved,
  type SourceRef,
} from '@caseguard/schemas';
import { MalformedRequestError, NotFoundError, ValidationFailedError } from '../../errors';
import type { QueryOf } from '../../http/route-binder';
import type { RequestContext } from '../../http/request-context';
import { computationFor, type ViewDeps } from './computation';
import { knownBy } from './instants';
import { loadViewState } from './state';

type LinkType = EvidenceLink['type'];

/** A link as a client writes it: what it points at, with no label of its own. */
export interface RequestedLink {
  readonly type: LinkType;
  readonly id: string;
}

const LINK_TYPE_SCHEMA = EvidenceLinkSchema.shape.type;
const LINK_FORM = `type:id, where type is one of ${LINK_TYPE_SCHEMA.options.join(', ')}`;

/**
 * Reads `links=type:id,type:id`. An id never contains a comma and a type never a colon, so the first
 * colon ends the type and the rest is the id (ids may hold colons). Duplicates are ignored, the first
 * one keeping its place. An entry that is not `type:id` is a 400 that names its position, never its text.
 */
export function parseProvenanceLinks(text: string): RequestedLink[] {
  const seen = new Set<string>();
  const links: RequestedLink[] = [];
  text.split(',').forEach((raw, index) => {
    const entry = raw.trim();
    const colon = entry.indexOf(':');
    const type = colon < 0 ? null : LINK_TYPE_SCHEMA.safeParse(entry.slice(0, colon));
    const id = colon < 0 ? null : IdSchema.safeParse(entry.slice(colon + 1));
    if (type === null || !type.success || id === null || !id.success) {
      throw new MalformedRequestError(`Link ${index + 1} is not of the form ${LINK_FORM}`);
    }
    const key = `${type.data}:${id.data}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ type: type.data, id: id.data });
  });
  if (links.length > PROVENANCE_MAX_LINKS) {
    throw new ValidationFailedError(
      `At most ${PROVENANCE_MAX_LINKS} different links can be resolved at once`,
      [{ path: 'links', message: `Got ${links.length}` }],
    );
  }
  return links;
}

/** Cuts text to a contract length without leaving half of an emoji behind. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

const eventTitle = (event: CaseEvent): string =>
  clip(event.title?.trim() || EVENT_TYPE_LABELS[event.type], 300);

const eventRef = (event: CaseEvent | null): ProvenanceItem['event'] =>
  event === null
    ? null
    : {
        id: event.id,
        title: eventTitle(event),
        type: event.type,
        participantRole: event.participantRole,
        timestamp: event.timestamp,
      };

/** The events a response names, each read once. */
class EventReader {
  private readonly memo = new Map<string, CaseEvent | null>();

  constructor(
    private readonly ctx: RequestContext,
    private readonly caseId: string,
  ) {}

  async get(id: string | null): Promise<CaseEvent | null> {
    if (id === null) return null;
    const cached = this.memo.get(id);
    if (cached !== undefined) return cached;
    const event = await this.ctx.repos.cases.getEvent(this.caseId, id);
    this.memo.set(id, event);
    return event;
  }
}

/** The analysis artefacts a link can point at, wherever they are read from. */
interface Artefacts {
  evidence(id: string): Promise<Evidence | null>;
  claim(id: string): Promise<Claim | null>;
  fork(id: string): Promise<DecisionFork | null>;
  action(id: string): Promise<DiagnosticAction | null>;
  /** A hypothesis is named by its record id or by the knowledge-pack key that claims and checks use. */
  hypothesis(idOrKey: string): Promise<Hypothesis | null>;
  /** A requirement is named by the knowledge-pack id the checks use, or by its missing-evidence record id. */
  requirement(idOrRequirementId: string): Promise<MissingEvidence | null>;
}

/** The stored analysis of the case: what a view of the whole record serves. */
class StoredArtefacts implements Artefacts {
  private readonly claims = new Map<string, Claim | null>();
  private readonly forks = new Map<string, DecisionFork | null>();
  private evidenceById: Promise<Map<string, Evidence>> | undefined;
  private actions: Promise<DiagnosticAction[]> | undefined;
  private hypotheses: Promise<Hypothesis[]> | undefined;
  private missing: Promise<MissingEvidence[]> | undefined;

  constructor(
    private readonly ctx: RequestContext,
    private readonly caseId: string,
    /** The evidence ids of the request, read together. */
    private readonly evidenceIds: readonly string[],
  ) {}

  async evidence(id: string): Promise<Evidence | null> {
    this.evidenceById ??= this.ctx.repos.analysis
      .listEvidence(this.caseId, { ids: this.evidenceIds })
      .then((items) => new Map(items.map((item) => [item.id, item])));
    return (await this.evidenceById).get(id) ?? null;
  }

  async claim(id: string): Promise<Claim | null> {
    if (!this.claims.has(id)) {
      this.claims.set(id, await this.ctx.repos.analysis.getClaim(this.caseId, id));
    }
    return this.claims.get(id) ?? null;
  }

  async fork(id: string): Promise<DecisionFork | null> {
    if (!this.forks.has(id)) {
      this.forks.set(id, await this.ctx.repos.analysis.getFork(this.caseId, id));
    }
    return this.forks.get(id) ?? null;
  }

  async action(id: string): Promise<DiagnosticAction | null> {
    this.actions ??= this.ctx.repos.analysis.listActions(this.caseId);
    return (await this.actions).find((item) => item.id === id) ?? null;
  }

  async hypothesis(idOrKey: string): Promise<Hypothesis | null> {
    this.hypotheses ??= this.ctx.repos.analysis.listHypotheses(this.caseId);
    return (
      (await this.hypotheses).find((item) => item.id === idOrKey || item.key === idOrKey) ?? null
    );
  }

  async requirement(idOrRequirementId: string): Promise<MissingEvidence | null> {
    this.missing ??= this.ctx.repos.analysis.listMissing(this.caseId);
    return (
      (await this.missing).find(
        (item) => item.requirementId === idOrRequirementId || item.id === idOrRequirementId,
      ) ?? null
    );
  }
}

/** What the engine derives from only what was known at an instant: never a filtered copy of the stored analysis. */
class WindowArtefacts implements Artefacts {
  constructor(private readonly analysis: DeterministicAnalysis) {}

  evidence(id: string): Promise<Evidence | null> {
    return Promise.resolve(this.analysis.evidence.find((item) => item.id === id) ?? null);
  }

  claim(id: string): Promise<Claim | null> {
    return Promise.resolve(this.analysis.claims.find((item) => item.id === id) ?? null);
  }

  fork(id: string): Promise<DecisionFork | null> {
    return Promise.resolve(this.analysis.forks.find((item) => item.id === id) ?? null);
  }

  action(id: string): Promise<DiagnosticAction | null> {
    return Promise.resolve(this.analysis.actions.find((item) => item.id === id) ?? null);
  }

  hypothesis(idOrKey: string): Promise<Hypothesis | null> {
    return Promise.resolve(
      this.analysis.hypotheses.find((item) => item.id === idOrKey || item.key === idOrKey) ?? null,
    );
  }

  requirement(idOrRequirementId: string): Promise<MissingEvidence | null> {
    return Promise.resolve(
      this.analysis.missing.find(
        (item) => item.requirementId === idOrRequirementId || item.id === idOrRequirementId,
      ) ?? null,
    );
  }
}

const DERIVED_TYPES: ReadonlySet<LinkType> = new Set([
  'evidence',
  'claim',
  'fork',
  'action',
  'hypothesis',
  'requirement',
]);

const NOTHING_TO_COMPARE: ExcerptCheck = {
  verification: 'not_checkable',
  reason: 'no_location',
  context: null,
};

/**
 * Where a quotation came from: the event, the field and offsets recorded, the recorded excerpt, whether
 * the stored text holds it, and the hash of the stored payload of the source the event belongs to. The
 * verbatim context is present only for an excerpt that was verified.
 */
function sourceOf(
  event: CaseEvent | null,
  ref: SourceRef | null,
  source: CaseSource | null,
): ProvenanceSource | null {
  const eventId = event?.id ?? ref?.eventId;
  if (ref === null || eventId === undefined) return null;
  const check = event === null ? NOTHING_TO_COMPARE : verifyExcerpt(event, ref);
  const sourceId = ref.sourceId ?? event?.sourceId ?? null;
  return {
    eventId,
    sourceId,
    field: ref.field ?? null,
    start: ref.start ?? null,
    end: ref.end ?? null,
    excerpt: ref.excerpt ?? null,
    verification: check.verification,
    contentHash:
      source !== null && sourceId !== null && source.id === sourceId ? source.storedSha256 : null,
    context: check.verification === 'verified' ? check.context : null,
  };
}

type Found = Omit<ProvenanceItem, 'link'>;
type Resolved = { readonly item: Found } | { readonly reason: ProvenanceUnresolved['reason'] };

const NOT_FOUND: Resolved = { reason: 'not_found' };
const NOT_YET_KNOWN: Resolved = { reason: 'not_yet_known' };

/**
 * Resolves evidence links to what they point at, in the view the caller asks for. Evidence and claims
 * come with their source: the event, where in its text they were found, whether the stored text holds
 * the recorded excerpt (`verified`, `mismatch`, `not_checkable`), the hash of the stored source payload,
 * and the verbatim surrounding text only when the excerpt was verified.
 *
 * Inside an `asOf` window nothing recorded later is shown: an event or scenario that came later, and a
 * derived record the engine does not yet produce on what was known then, are reported as
 * `not_yet_known` with nothing else about them, and the records that are known come from the engine's
 * analysis of that window, exactly as the other views serve them. A link to nothing is `not_found`, and
 * so is a derived link of a case that was never analysed. Nothing is written and no case text is logged.
 */
export async function resolveProvenance(
  ctx: RequestContext,
  deps: ViewDeps,
  caseId: string,
  query: QueryOf<'provenance.resolve'>,
): Promise<ProvenanceResponse> {
  const asOf = query.asOf ?? null;
  const known = knownBy(asOf);
  if ((await ctx.repos.cases.get(caseId)) === null) throw new NotFoundError('Case', caseId);
  const links = parseProvenanceLinks(query.links);

  const events = new EventReader(ctx, caseId);
  const stored = new StoredArtefacts(
    ctx,
    caseId,
    links.filter((link) => link.type === 'evidence').map((link) => link.id),
  );
  let artefacts: Artefacts | null = null;
  if (links.some((link) => DERIVED_TYPES.has(link.type))) {
    if ((await ctx.repos.analysis.getLatestRun(caseId)) !== null) {
      artefacts =
        asOf === null
          ? stored
          : new WindowArtefacts(
              await computationFor(ctx, deps, await loadViewState(ctx, caseId), asOf).analysis(),
            );
    }
  }
  const source = links.some((link) => link.type === 'evidence' || link.type === 'claim')
    ? await ctx.repos.cases.getSource(caseId)
    : null;

  /**
   * A derived record: found in the view that was asked for, or else known to the stored analysis (so it
   * comes after `asOf`), or nowhere.
   */
  const derived = async <T>(
    find: (from: Artefacts) => Promise<T | null>,
    build: (found: T) => Promise<Found>,
  ): Promise<Resolved> => {
    const found = artefacts === null ? null : await find(artefacts);
    if (found !== null) return { item: await build(found) };
    const comesLater = asOf !== null && artefacts !== stored && (await find(stored)) !== null;
    return comesLater ? NOT_YET_KNOWN : NOT_FOUND;
  };

  /** A simulated path belongs to the decision it was made for, and that decision's event is where it points. */
  const scenarioItem = async (scenario: CounterfactualScenario): Promise<Found> => {
    const fork = await stored.fork(scenario.forkId);
    return {
      title: clip(scenario.label, 300),
      at: scenario.boundary.asOf,
      event: eventRef(await events.get(fork?.eventId ?? null)),
      source: null,
    };
  };

  const resolveOne = async (link: RequestedLink): Promise<Resolved> => {
    switch (link.type) {
      case 'event': {
        const event = await events.get(link.id);
        if (event === null) return NOT_FOUND;
        if (!known(event.timestamp)) return NOT_YET_KNOWN;
        return {
          item: {
            title: eventTitle(event),
            at: event.timestamp,
            event: eventRef(event),
            source: null,
          },
        };
      }
      case 'evidence':
        return derived(
          (from) => from.evidence(link.id),
          async (found) => {
            const event = await events.get(found.eventId);
            return {
              title: clip(found.label, 300),
              at: found.observedAt,
              event: eventRef(event),
              source: sourceOf(event, found.sourceRef, source),
            };
          },
        );
      case 'claim':
        return derived(
          (from) => from.claim(link.id),
          async (found) => {
            const event = await events.get(found.eventId);
            return {
              title: clip(found.text, 300),
              at: found.timestamp,
              event: eventRef(event),
              source: sourceOf(event, found.sourceRef, source),
            };
          },
        );
      case 'fork':
        return derived(
          (from) => from.fork(link.id),
          async (found) => ({
            title: clip(found.title, 300),
            at: found.timestamp,
            event: eventRef(await events.get(found.eventId)),
            source: null,
          }),
        );
      case 'action':
        return derived(
          (from) => from.action(link.id),
          async (found) => ({
            title: clip(found.label, 300),
            at: found.startedAt,
            event: eventRef(await events.get(found.eventId)),
            source: null,
          }),
        );
      case 'hypothesis':
        return derived(
          (from) => from.hypothesis(link.id),
          (found) =>
            Promise.resolve({ title: clip(found.name, 300), at: null, event: null, source: null }),
        );
      case 'requirement':
        return derived(
          (from) => from.requirement(link.id),
          async (found) => ({
            title: clip(found.label, 300),
            at: found.firstRelevantAt,
            event: eventRef(await events.get(found.resolvedByEventId)),
            source: null,
          }),
        );
      case 'scenario': {
        const scenario = await ctx.repos.counterfactuals.get(caseId, link.id);
        if (scenario === null) return NOT_FOUND;
        if (!known(scenario.boundary.asOf)) return NOT_YET_KNOWN;
        return { item: await scenarioItem(scenario) };
      }
    }
  };

  const items: ProvenanceItem[] = [];
  const unresolved: ProvenanceUnresolved[] = [];
  for (const link of links) {
    const resolved = await resolveOne(link);
    if ('item' in resolved) items.push({ link, ...resolved.item });
    else unresolved.push({ link, reason: resolved.reason });
  }
  return { caseId, asOf, items, unresolved };
}
