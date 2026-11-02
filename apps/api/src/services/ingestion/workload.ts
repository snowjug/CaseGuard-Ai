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

function unstatedMessage(sourceKind: SourceKind): string {
  const how =
    sourceKind === 'uploaded_file'
      ? 'Choose the workload for this file (a text file may start with a "Workload: <key>" line instead; a CSV file cannot state one).'
      : 'Enter it in the Workload field, or put a "Workload: <key>" line before the first message.';
  return [
    'No workload was stated, and CaseGuard does not guess it.',
    how,
    `Supported workloads: ${supportedWorkloads()}.`,
  ].join(' ');
}

function unsupportedMessage(workload: string): string {
  return `No knowledge pack is available for the "${workload}" workload (supported: ${supportedWorkloads()}).`;
}

function conflictMessage(stated: string, chosen: string): string {
  return `The file states the "${stated}" workload, but "${chosen}" was chosen. Choose the one the file states, or leave the choice empty.`;
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
 * - Nothing is ever assumed. When the parser had to fall back to its default (pasted text, a CSV file or a text
 *   file that states no workload and was given none), the case is refused and the message says how to state it.
 *   Built-in samples and JSON bundles always state theirs.
 * - A JSON bundle file states its workload, so a different choice made for it is a contradiction and is refused.
 * - A workload that no knowledge pack covers is refused here, at the door, instead of when the analysis starts. The
 *   analysis still refuses it (`loadAnalysisInputs`), as a second line of defence for cases stored another way.
 */
export function checkWorkload(
  parse: IngestSuccess,
  sourceKind: SourceKind,
  chosen: string | null = null,
): WorkloadCheck {
  const assumed = parse.warnings.some((warning) => warning.code === ASSUMED);
  if (assumed) {
    return {
      issues: [errorIssue(WORKLOAD_PATH, unstatedMessage(sourceKind))],
      warnings: parse.warnings.filter((warning) => warning.code !== ASSUMED),
    };
  }
  const workload = parse.bundle.case.workload;
  if (chosen !== null && chosen !== workload) {
    return {
      issues: [errorIssue(WORKLOAD_PATH, conflictMessage(workload, chosen))],
      warnings: parse.warnings,
    };
  }
  const covered = listKnowledgePacks().some((pack) => pack.workload === workload);
  return {
    issues: covered ? [] : [errorIssue(WORKLOAD_PATH, unsupportedMessage(workload))],
    warnings: parse.warnings,
  };
}
