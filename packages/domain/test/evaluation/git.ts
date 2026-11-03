import { execFileSync } from 'node:child_process';
import { REPOSITORY_ROOT } from './dataset';

const git = (args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** The commit the working tree is on. */
export const gitHead = (): string => git(['rev-parse', 'HEAD']).trim();

/**
 * Paths under the given repository-relative ones that differ from the last commit: modified, staged, deleted or not
 * tracked yet. Empty when everything under them is committed.
 */
export function uncommittedUnder(paths: readonly string[]): string[] {
  return git(['status', '--porcelain', '--untracked-files=all', '--', ...paths])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}
