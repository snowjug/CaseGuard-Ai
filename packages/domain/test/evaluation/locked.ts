import { canonicalJson, sha256 } from './dataset';
import type { LockedRunRecord, LockedRuns, Manifest } from './schema';

/**
 * The log of locked runs is append-only: every record carries the hash of the one before it, and its own hash covers
 * everything else in it. Editing or removing an earlier record breaks the chain from there on.
 */

export type RunBody = Omit<LockedRunRecord, 'hash'>;

export const recordHash = (body: RunBody): string => sha256(canonicalJson(body));

/** Appends a record to a log; the log it is given is not changed. */
export function appendRun(log: LockedRuns, body: Omit<RunBody, 'index' | 'previous'>): LockedRuns {
  const last = log.runs[log.runs.length - 1];
  const full: RunBody = { ...body, index: log.runs.length + 1, previous: last ? last.hash : null };
  return { ...log, runs: [...log.runs, { ...full, hash: recordHash(full) }] };
}

/** What is wrong with a log of locked runs; empty when it is sound. */
export function verifyChain(log: LockedRuns, lockHash: string | null): string[] {
  const problems: string[] = [];
  let previous: string | null = null;
  log.runs.forEach((record, position) => {
    const { hash, ...body } = record;
    if (record.index !== position + 1)
      problems.push(`record ${position + 1} has index ${record.index}`);
    if (record.previous !== previous)
      problems.push(`record ${record.index}: "previous" is not the hash of the record before`);
    if (recordHash(body) !== hash)
      problems.push(`record ${record.index}: its hash does not match its content`);
    if (lockHash !== null && record.testSetSha256 !== lockHash) {
      problems.push(`record ${record.index}: it ran a test split other than the locked one`);
    }
    previous = hash;
  });
  return problems;
}

/** What stands in the way of a locked run; empty when it may go ahead. */
export function lockProblems(input: {
  readonly manifest: Manifest | null;
  /** `git status` lines under the test cases and the annotations of the test cases. */
  readonly uncommitted: readonly string[];
  readonly testHash: string;
  readonly log: LockedRuns;
}): string[] {
  const { manifest, uncommitted, testHash, log } = input;
  if (manifest === null || manifest.locked === null) {
    return [
      'The test split is not locked yet. Commit it, then run `pnpm --filter @caseguard/domain run eval:manifest -- --lock`.',
    ];
  }
  const problems: string[] = [];
  if (uncommitted.length > 0) {
    problems.push(
      `Uncommitted changes under evaluation/cases/test or in the annotations of the test cases:\n${uncommitted.join('\n')}`,
    );
  }
  if (testHash !== manifest.locked.testSetSha256) {
    problems.push('The test split differs from the one that was locked.');
  }
  const chain = verifyChain(log, manifest.locked.testSetSha256);
  if (chain.length > 0) problems.push(`The log of locked runs is broken:\n${chain.join('\n')}`);
  return problems;
}
