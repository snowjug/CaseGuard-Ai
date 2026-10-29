import type {
  CaseStatus,
  Channel,
  EffortLevel,
  EventType,
  ParticipantRole,
  Severity,
} from '@caseguard/schemas';
import type { WarningCollector } from './text';
import type {
  EventNote,
  ParseStats,
  ParserSource,
  RoleBasis,
  TimestampBasis,
  TypeBasis,
} from './types';
import type { ResolvedOptions } from './options';

export interface DraftSpeaker {
  key: string;
  label: string;
  role: ParticipantRole;
  roleBasis: RoleBasis;
  /** The role could not be told, so the speaker is kept neutral and flagged. */
  unidentified: boolean;
}

export interface DraftAction {
  label: string;
  actionKey?: string;
  customerEffort?: EffortLevel;
  destructive?: boolean;
  durationMinutes?: number;
}

export interface DraftEvent {
  /** Unique reference used by `inResponseTo`; replaced by the final id on assembly. */
  ref: string;
  /** Position in the source, used as the tie-breaker for equal timestamps. */
  order: number;
  /** 1-based source line (transcript) or spreadsheet row (CSV). */
  at: number;
  timestampMs: number;
  timestampBasis: TimestampBasis;
  zoneAssumed: boolean;
  speakerKey: string;
  type: EventType;
  typeBasis: TypeBasis;
  title: string | null;
  body: string;
  channel: Channel | null;
  action: DraftAction | null;
  inResponseTo: string | null;
  inResponseToBasis: EventNote['inResponseToBasis'];
  correlationIds: string[];
  explicitId: string | null;
}

/** Case details written in the text itself (a transcript preamble such as `Severity: B`). */
export interface HeaderMeta {
  title?: string;
  reference?: string;
  product?: string;
  workload?: string;
  severity?: Severity;
  status?: CaseStatus;
  customerAlias?: string;
}

export interface ResolutionDraft {
  /** `ref` of the resolution-note event. */
  ref: string;
  summary: string;
  rootCause: string;
  workaround?: string;
  permanentFix?: string;
}

export interface AssembleInput {
  source: ParserSource;
  options: ResolvedOptions;
  speakers: ReadonlyMap<string, DraftSpeaker>;
  /** Events in source order. */
  events: readonly DraftEvent[];
  warnings: WarningCollector;
  stats: Pick<ParseStats, 'inputChars' | 'inputBytes' | 'lines' | 'ignoredLines' | 'skippedRows'>;
  nonBlankLines: number;
  header: HeaderMeta;
  /** Title derived from the content when nothing else supplies one. */
  derivedTitle: string | null;
  tag: string;
  /** Text hashed into the default reference so identical input gets an identical reference. */
  referenceSeed: string;
  resolution: ResolutionDraft | null;
  statusEvent: { ref: string; status: 'resolved' | 'closed' } | null;
  mergedSpeakers: boolean;
  truncatedBodies: number;
}

export function emptyStats(
  counts: Pick<ParseStats, 'inputChars' | 'inputBytes' | 'lines'>,
): ParseStats {
  return { ...counts, events: 0, participants: 0, ignoredLines: 0, skippedRows: 0 };
}
