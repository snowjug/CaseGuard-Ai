import { describe, expect, it, vi } from 'vitest';
import type { CaseListItem, CaseListQuery, TenantRepositories } from '../src/db';
import { findCaseByReference, referenceInUseMessage } from '../src/services/ingestion/reference';
import { listItemOf } from './ingestion-fixtures';

interface Page {
  readonly items: readonly CaseListItem[];
  readonly nextCursor: string | null;
}

/** Repositories whose case list answers the given pages in order (the last one repeats). */
function reposWith(pages: readonly Page[]) {
  let call = 0;
  const list = vi.fn((_query: CaseListQuery) => {
    const page = pages[Math.min(call, pages.length - 1)] ?? { items: [], nextCursor: null };
    call += 1;
    return Promise.resolve({ items: [...page.items], nextCursor: page.nextCursor });
  });
  return { repos: { cases: { list } } as unknown as TenantRepositories, list };
}

describe('findCaseByReference (preview and create share it)', () => {
  it('searches for the reference and returns the case that has exactly that reference', async () => {
    const { repos, list } = reposWith([
      {
        items: [listItemOf('a', 'CG-100'), listItemOf('b', 'CG-10'), listItemOf('c', 'CG-1000')],
        nextCursor: null,
      },
    ]);
    expect((await findCaseByReference(repos, 'CG-10'))?.id).toBe('b');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ limit: 200, q: 'CG-10' });
  });

  it('does not take a longer reference, or the same letters in another case, for a match', async () => {
    const { repos } = reposWith([
      { items: [listItemOf('a', 'CG-100'), listItemOf('b', 'cg-10')], nextCursor: null },
    ]);
    expect(await findCaseByReference(repos, 'CG-10')).toBeNull();
  });

  it('follows the cursor to later pages and stops at the first match', async () => {
    const { repos, list } = reposWith([
      { items: [listItemOf('a', 'CG-100')], nextCursor: 'cursor-1' },
      { items: [listItemOf('b', 'CG-10')], nextCursor: 'cursor-2' },
      { items: [listItemOf('c', 'CG-10')], nextCursor: null },
    ]);
    expect((await findCaseByReference(repos, 'CG-10'))?.id).toBe('b');
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ limit: 200, q: 'CG-10', cursor: 'cursor-1' });
  });

  it('gives up without a verdict after ten pages (the limit an exact lookup would remove)', async () => {
    const { repos, list } = reposWith([{ items: [listItemOf('a', 'CG-100')], nextCursor: 'more' }]);
    expect(await findCaseByReference(repos, 'CG-10')).toBeNull();
    expect(list).toHaveBeenCalledTimes(10);
  });

  it('words the refusal the same for the preview and the conflict, naming the reference', () => {
    const message = referenceInUseMessage('CG-10');
    expect(message).toContain('CG-10');
    expect(message).toContain('different content');
    expect(message).toContain('delete the existing case');
  });
});
