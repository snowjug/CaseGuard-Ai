/**
 * Public surface of the ingestion parsers. Generic type names carry an `Ingest` prefix so that
 * `export *` from the domain barrel can never collide with other modules.
 */
export { IngestParseError, type IngestErrorCode } from './errors';
export {
  DEFAULT_PARSER_LIMITS,
  HARD_PARSER_LIMITS,
  resolveLimits,
  type ParserLimits,
} from './limits';
export type {
  ConfidenceLevel as IngestConfidenceLevel,
  CsvField as CsvColumnField,
  CsvOptions as CsvParseOptions,
  DateOrder as IngestDateOrder,
  DraftFailure as IngestFailure,
  DraftOptions as IngestDraftOptions,
  DraftSuccess as IngestSuccess,
  EventNote as IngestEventNote,
  IdFactory as IngestIdFactory,
  JsonBundleOptions as JsonBundleParseOptions,
  ParseConfidence as IngestConfidence,
  ParseIssue as IngestIssue,
  ParseIssueCode as IngestIssueCode,
  ParseResult as IngestParseResult,
  ParserSource as IngestSource,
  ParseStats as IngestStats,
  ParseWarning as IngestWarning,
  RoleBasis as IngestRoleBasis,
  SpeakerSummary as IngestSpeaker,
  TimestampBasis as IngestTimestampBasis,
  TranscriptOptions as TranscriptParseOptions,
  TypeBasis as IngestTypeBasis,
  WarningCode as IngestWarningCode,
  WarningSeverity as IngestWarningSeverity,
} from './types';
export { ISSUE_CODES as INGEST_ISSUE_CODES, WARNING_CODES as INGEST_WARNING_CODES } from './types';
export {
  defaultIdFactory as defaultIngestIdFactory,
  DEFAULT_WORKLOAD as DEFAULT_INGEST_WORKLOAD,
} from './options';
export { parsePastedTranscript, TRANSCRIPT_FORMAT_HINT } from './transcript';
export { parseCsvEvents, CSV_FORMAT_HINT } from './csv';
export { CSV_ALIASES } from './csv-columns';
export {
  checkSchemaVersion,
  checkValueShape,
  parseCaseBundleJson,
  validateCaseBundleValue,
} from './bundle-json';
export {
  buildDraftPreview,
  overviewOf,
  toValidationIssues,
  type DraftOverview,
  type DraftPreview,
  type IngestionPreviewParts,
  type PreviewOptions as DraftPreviewOptions,
  type RoleOverview as DraftRoleOverview,
  type WarningOverview as DraftWarningOverview,
} from './preview';
export {
  buildJsonSchemaDocuments,
  skillJsonSchema,
  type JsonSchemaDocument,
} from './schema-export';
