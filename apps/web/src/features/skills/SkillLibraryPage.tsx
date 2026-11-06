'use client';

import { SKILL_LIFECYCLE } from '@caseguard/schemas';
import {
  BentoGrid,
  BlurFade,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Select,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import {
  FlaskConicalIcon,
  FolderIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SearchXIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { boundedString } from '../../lib/url-codecs';
import { codecs, useUrlChoiceState, useUrlTextState } from '../../lib/url-state';
import { LIFECYCLE_LABELS, LIFECYCLE_MEANING, LIFECYCLE_PATH } from './labels';
import { SkillCard } from './SkillCard';
import { LibrarySkeleton } from './Skeleton';

const LIFECYCLE_VALUES = ['all', ...SKILL_LIFECYCLE] as const;
type LifecycleFilter = (typeof LIFECYCLE_VALUES)[number];
const LIFECYCLE_CODEC = codecs.enumOf(LIFECYCLE_VALUES, 'all');
const PAGE_SIZE = 25;
const MAX_SEARCH = 200;
const SEARCH = boundedString(MAX_SEARCH);

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  busy: { opacity: 0.72 },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: cg.space[3] },
  search: { flex: '2 1 280px', minWidth: 0, '@media (max-width: 639px)': { flex: '1 1 100%' } },
  // On a phone the status and the actions share one row under the search.
  status: {
    flex: '0 1 240px',
    minWidth: '160px',
    '@media (max-width: 639px)': { flex: '1 1 0' },
  },
  select: { width: '100%' },
  actions: { display: 'flex', alignItems: 'center', gap: cg.space[1], marginInlineStart: 'auto' },
  count: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
  grid: { margin: 0, padding: 0, listStyle: 'none' },
  more: { display: 'flex', justifyContent: 'center' },
  problem: {
    margin: 0,
    textAlign: 'center',
    fontSize: tokens.fontSizeBase300,
    color: cg.tone.unsupported.fg,
  },
});

const PAGE_HELP = (
  <>
    <p>
      A skill is a reusable fix: a step-by-step plan taken from a case that was reviewed, so the
      next person can follow it. SkillDNA is its technical name: a governed, reusable investigation
      plan.
    </p>
    <p>
      A skill is never published automatically: every step of its status needs a person with the
      right role, and publishing needs someone other than its creator and its pilot approver.
    </p>
    <p>The status, in order:</p>
    <ul>
      {LIFECYCLE_PATH.map((state) => (
        <li key={state}>
          <strong>{LIFECYCLE_LABELS[state]}.</strong> {LIFECYCLE_MEANING[state]}
        </li>
      ))}
    </ul>
    <p>
      Deprecated and Retired mean the skill was withdrawn: it is no longer offered for new matches.
    </p>
    <p>
      Estimated success is a model estimate. With demo data it shows how the pipeline works and is
      not evidence of real-world results.
    </p>
  </>
);

function EmptyLibrary() {
  const { caseId } = useActiveCase();
  return (
    <EmptyState
      headingLevel={2}
      icon={<PuzzleIcon />}
      title="No skills yet"
      description="Skills appear after a case is reviewed. Accept a safer path on a case’s What if page and save it as a skill: it shows up here as a draft, ready to be checked."
      action={
        <ButtonLink
          href={caseId ? caseHref(caseId, 'counterfactual') : '/cases'}
          variant="primary"
          icon={caseId ? <FlaskConicalIcon /> : <FolderIcon />}
        >
          {caseId ? 'Open What if' : 'Open cases'}
        </ButtonLink>
      }
    />
  );
}

function LibraryContent() {
  const styles = useStyles();
  const auth = useAuth();
  const [lifecycle, setLifecycle] = useUrlChoiceState('lifecycle', LIFECYCLE_CODEC);
  // The search text is typed, so it lives in the field and reaches the URL when typing pauses (see `useUrlTextState`).
  const searchField = useUrlTextState('q', SEARCH);
  const q = searchField.value;
  const search = useDebouncedValue(q.trim(), 300);
  const params = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(lifecycle !== 'all' ? { lifecycle } : {}),
      ...(search ? { q: search } : {}),
    }),
    [lifecycle, search],
  );
  const pages = useApiPages(
    'skills.list',
    { query: params },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  const active = lifecycle !== 'all' || q.trim() !== '';
  // What the answer on screen was asked for: the search text is sent after a pause, the status at once.
  const asked = lifecycle !== 'all' || search !== '';
  const skills = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);
  const clear = (): void => {
    searchField.set('');
    setLifecycle('all');
  };

  return (
    <QueryBoundary
      query={pagedBoundary(pages)}
      subject="Skills"
      skeleton={<LibrarySkeleton />}
      // The empty library is for the answer to an unfiltered request. While the answer of a search that found nothing is
      // still on screen (just cleared, the full list on its way) the form must stay, or it is gone while typing.
      isEmpty={(value) =>
        !asked && !pages.isPlaceholderData && (value.pages[0]?.items.length ?? 0) === 0
      }
      empty={<EmptyLibrary />}
    >
      {(_data, meta) => (
        <div className={styles.page}>
          <BlurFade index={0}>
            <form
              role="search"
              aria-label="Filter skills"
              className={styles.toolbar}
              onSubmit={(event) => event.preventDefault()}
            >
              <Field label="Search" className={styles.search}>
                <Input
                  {...searchField.inputProps}
                  type="search"
                  placeholder="Name, workload or description"
                  startIcon={<SearchIcon />}
                  maxLength={MAX_SEARCH}
                />
              </Field>
              <Field label="Status" className={styles.status}>
                <Select
                  className={styles.select}
                  value={lifecycle}
                  onChange={(event) => setLifecycle(event.target.value as LifecycleFilter)}
                >
                  <option value="all">Any status</option>
                  {SKILL_LIFECYCLE.map((state) => (
                    <option key={state} value={state}>
                      {LIFECYCLE_LABELS[state]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className={styles.actions}>
                {active ? (
                  <Button variant="ghost" onClick={clear}>
                    Clear filters
                  </Button>
                ) : null}
                <IconButton
                  icon={<RefreshCwIcon />}
                  label={pages.isFetching && !pages.isPending ? 'Refreshing…' : 'Refresh'}
                  loading={pages.isFetching}
                  onClick={() => void pages.refetch()}
                />
              </div>
            </form>
          </BlurFade>
          <p role="status" aria-live="polite" className={styles.count}>
            {skills.length === 0
              ? 'No loaded skill matches.'
              : `Showing ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${pages.hasNextPage ? '; more are available' : ''}.`}
          </p>
          {skills.length === 0 ? (
            <EmptyState
              compact
              headingLevel={2}
              icon={<SearchXIcon />}
              title="No skills match"
              description="Try another word, or show every status."
              action={
                <Button variant="secondary" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <BentoGrid
              as="ul"
              role="list"
              aria-label="Skills"
              aria-busy={meta.isRefreshing}
              className={mergeClasses(styles.grid, meta.isRefreshing && styles.busy)}
            >
              {skills.map((skill, index) => (
                <SkillCard key={skill.id} skill={skill} headingLevel={2} index={index + 1} />
              ))}
            </BentoGrid>
          )}
          {pages.hasNextPage ? (
            <div className={styles.more}>
              <Button
                variant="ghost"
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
              >
                {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {pages.isFetchNextPageError ? (
            <p role="alert" className={styles.problem}>
              The next page could not be loaded. Try “Load more” again.
            </p>
          ) : null}
        </div>
      )}
    </QueryBoundary>
  );
}

/**
 * Skills (`/skills`): reusable fixes that worked on earlier cases, as a grid of cards with their status, estimated success
 * and how often each was used. `?lifecycle=` and `?q=` filter on the server, and results load page by page on request.
 */
export function SkillLibraryPage() {
  return (
    <>
      <PageHeader title="Skills" description="Reuse fixes that worked before." help={PAGE_HELP} />
      <PermissionGate
        permission="skill:read"
        subject="skills"
        grantedTo="Every role"
        skeleton={<LibrarySkeleton />}
      >
        <LibraryContent />
      </PermissionGate>
    </>
  );
}
