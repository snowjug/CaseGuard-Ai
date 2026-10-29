import type { ReviewDecision } from '@caseguard/schemas';
import { AUDIT_GENESIS_HASH } from '../../db';
import { NotFoundError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { sanitizeAuditEvent } from './audit';
import { maskSecrets } from './mask-secrets';

export type BundleContext = Pick<RequestContext, 'repos'>;

/** What an export loader produced: the payload plus the facts the audit event and notice need. */
export interface ExportBundle {
  readonly data: Record<string, unknown>;
  readonly recordCount: number;
  /** True when the exported records belong to a synthetic case or tenant (shown in the notice). */
  readonly synthetic: boolean;
}

/** A loader refuses (instead of truncating) when the export would exceed the configured cap. */
export type BundleOutcome =
  | { readonly ok: true; readonly bundle: ExportBundle }
  | { readonly ok: false; readonly recordCount: number };

const REVIEW_PAGE_SIZE = 200;

/** Reviewer decisions of one case, stopping as soon as more than `room` have been read. */
async function collectReviews(
  ctx: BundleContext,
  caseId: string,
  room: number,
): Promise<{ reviews: ReviewDecision[]; overflow: boolean }> {
  const reviews: ReviewDecision[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.repos.reviews.list({ caseId, limit: REVIEW_PAGE_SIZE, cursor });
    reviews.push(...page.items);
    if (reviews.length > room) return { reviews, overflow: true };
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { reviews, overflow: false };
}

/**
 * The redacted case record: the case, its source attestation (hashes and sizes, never the object-store
 * key or the payload), participants, timeline events, resolution and reviewer decisions. Event bodies
 * are the text stored at ingestion; the raw upload is not read back. Credentials are masked once more
 * on the way out in case the redaction settings were weaker when the case was ingested. Derived
 * analysis (claims, scores, hypotheses) is not included: it is regenerated from this record.
 */
export async function loadCaseBundle(
  ctx: BundleContext,
  caseId: string,
  cap: number,
): Promise<BundleOutcome> {
  const record = await ctx.repos.cases.get(caseId);
  if (record === null) throw new NotFoundError('Case', caseId);

  // The stored counters give a cheap early answer before anything large is read.
  const estimate = 1 + record.eventCount + (record.hasResolution ? 1 : 0);
  if (estimate > cap) return { ok: false, recordCount: estimate };

  const source = await ctx.repos.cases.getSource(caseId);
  const participants = await ctx.repos.cases.getParticipants(caseId);
  const events = await ctx.repos.cases.getAllEvents(caseId);
  const resolution = await ctx.repos.cases.getResolution(caseId);
  const known =
    1 + (source === null ? 0 : 1) + participants.length + events.length + (resolution ? 1 : 0);
  if (known > cap) return { ok: false, recordCount: known };

  const { reviews, overflow } = await collectReviews(ctx, caseId, cap - known);
  const recordCount = known + reviews.length;
  if (overflow) return { ok: false, recordCount };

  const publicSource = source === null ? null : omitStorageRef(source);
  const masked = maskSecrets({
    case: record,
    source: publicSource,
    participants,
    events,
    resolution,
    reviews,
  });
  return {
    ok: true,
    bundle: {
      recordCount,
      synthetic: record.synthetic,
      data: {
        format: 'caseguard.case-export',
        formatVersion: 1,
        ...masked.value,
        integrity: { valuesMaskedOnExport: masked.replacements },
      },
    },
  };
}

function omitStorageRef<T extends { storageRef: string }>(source: T): Omit<T, 'storageRef'> {
  const { storageRef: _internalKey, ...rest } = source;
  return rest;
}

const HASH_RECIPE = [
  'hash = sha256(prevHash + newline + canonicalJson(event without its "hash" field)).',
  'canonicalJson sorts object keys and has no insignificant whitespace.',
  'The first event has prevHash = genesisHash.',
].join(' ');

/**
 * The tenant's audit chain in sequence order, with the chain verification and what an auditor needs to
 * re-verify it independently (the recipe, the genesis hash and the head). The count is read from the
 * newest sequence number first, so an oversized chain is refused before it is loaded.
 */
export async function loadAuditBundle(ctx: BundleContext, cap: number): Promise<BundleOutcome> {
  const newest = await ctx.repos.audit.list({ limit: 1 });
  const total = newest.items[0]?.sequence ?? 0;
  if (total > cap) return { ok: false, recordCount: total };

  const tenant = await ctx.repos.governance.getTenant();
  const verification = await ctx.repos.audit.verify();
  const stored = await ctx.repos.audit.listForExport(cap);
  const sanitized = stored.map(sanitizeAuditEvent);
  const events = sanitized.map((entry) => entry.event);
  const last = events.at(-1);
  return {
    ok: true,
    bundle: {
      recordCount: events.length,
      synthetic: tenant.synthetic,
      data: {
        format: 'caseguard.audit-export',
        formatVersion: 1,
        events,
        verification,
        chain: {
          genesisHash: AUDIT_GENESIS_HASH,
          hashRecipe: HASH_RECIPE,
          head: last === undefined ? null : { sequence: last.sequence, hash: last.hash },
        },
        integrity: { eventsWithMaskedDetails: sanitized.filter((entry) => entry.masked).length },
      },
    },
  };
}
