import { listKnowledgePacks, type IngestSuccess, type IngestWarning } from '@caseguard/domain';
import type { SourceKind, ValidationIssue } from '@caseguard/schemas';
import { errorIssue } from './issues';

/** Where the preview and the wizard point for everything about the workload. */
export const WORKLOAD_PATH = 'case.workload';

const ASSUMED = 'workload_assumed';

const supportedWorkloads = (): string =>
  listKnowledgePacks()
    .map((pack) => pack.workload)
    .join(', ');

function unstatedMessage(): string {
  return [
    'No workload was stated, and CaseGuard does not guess it.',
    'Enter it in the Workload field, or put a "Workload: <key>" line before the first message.',
    `Supported workloads: ${supportedWorkloads()}.`,
  ].join(' ');
}

function unsupportedMessage(workload: string): string {
  return `No knowledge pack is available for the "${workload}" workload (supported: ${supportedWorkloads()}).`;
}

export interface WorkloadCheck {
  /** Errors that refuse the payload; none when the workload is stated where it can be and a knowledge pack covers it. */
  readonly issues: ValidationIssue[];
  /** The parser's warnings, without the one that an error above replaces. */
  readonly warnings: IngestWarning[];
}

/**
 * What the pipeline says about the workload, which decides the knowledge pack every analysis of the case uses.
 *
 * - A workload that no knowledge pack covers is refused here, at the door, instead of when the analysis starts. The
 *   analysis still refuses it (`loadAnalysisInputs`), as a second line of defence for cases stored another way.
 * - Nothing is assumed for pasted text: the request has a field for the workload and the text may carry a
 *   `Workload:` line, so a case with neither is refused and the message says how to state it.
 * - A file upload has no field for it (a CSV file cannot carry one), so for it the parser's default stays, with its
 *   warning in the preview: the workload was assumed, and the person is told so before confirming.
 */
export function checkWorkload(parse: IngestSuccess, sourceKind: SourceKind): WorkloadCheck {
  const assumed = parse.warnings.some((warning) => warning.code === ASSUMED);
  if (assumed && sourceKind === 'pasted_text') {
    return {
      issues: [errorIssue(WORKLOAD_PATH, unstatedMessage())],
      warnings: parse.warnings.filter((warning) => warning.code !== ASSUMED),
    };
  }
  const workload = parse.bundle.case.workload;
  const covered = listKnowledgePacks().some((pack) => pack.workload === workload);
  return {
    issues: covered ? [] : [errorIssue(WORKLOAD_PATH, unsupportedMessage(workload))],
    warnings: parse.warnings,
  };
}
