'use client';

import { SKILL_LIFECYCLE, SKILL_LIFECYCLE_LABELS } from '@caseguard/schemas';
import { EmptyState, Notice, PageHeader } from '@caseguard/ui';
import { Button, Field, Input, Select, mergeClasses } from '@fluentui/react-components';
import {
  ArrowSyncRegular,
  BeakerRegular,
  MoleculeRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { LinkButton } from '../../components/common/LinkButton';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useActiveCase } from '../../lib/active-case';
import { pagedBoundary, useApiPages } from '../../lib/api/pages';
import { useAuth } from '../../lib/auth/context';
import { caseHref } from '../../lib/deep-links';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { boundedString } from '../../lib/url-codecs';
import { codecs, useUrlStates, useUrlTextState } from '../../lib/url-state';
import { useInsightStyles } from '../quality/styles';
import { LIFECYCLE_MEANING } from './labels';
import { SkillCard } from './SkillCard';
import { LibrarySkeleton } from './Skeleton';

const LIFECYCLE_VALUES = ['all', ...SKILL_LIFECYCLE] as const;
const FILTERS = {
  lifecycle: codecs.enumOf(LIFECYCLE_VALUES, 'all'),
};
const PAGE_SIZE = 25;
const MAX_SEARCH = 200;
const SEARCH = boundedString(MAX_SEARCH);

const PAGE_HELP = (
  <>
    <p>
      SkillDNA turns validated investigation reasoning into reusable, governed skills. A skill is
      never published automatically: every step of its lifecycle needs a person with the right role,
      and publication needs someone other than its creator and its pilot approver.
    </p>
    <p>The lifecycle, in order:</p>
    <ul>
      {SKILL_LIFECYCLE.map((state) => (
        <li key={state}>
          <strong>{SKILL_LIFECYCLE_LABELS[state]}.</strong> {LIFECYCLE_MEANING[state]}
        </li>
      ))}
    </ul>
    <p>
      Confidence and effectiveness are model estimates. With synthetic data they demonstrate the
      pipeline and are not evidence of real-world effectiveness.
    </p>
  </>
);

function EmptyLibrary() {
  const { caseId } = useActiveCase();
  return (
    <EmptyState
      headingLevel={2}
      icon={<MoleculeRegular />}
      title="No skills yet"
      description="SkillDNA is extracted from a simulated path that a reviewer has accepted in the Counterfactual Lab. Extract one from a case, and it appears here as a draft to be reviewed."
      action={
        <LinkButton
          href={caseId ? caseHref(caseId, 'counterfactual') : '/cases'}
          appearance="primary"
          icon={<BeakerRegular />}
        >
          {caseId ? 'Open the Counterfactual Lab' : 'Open Cases'}
        </LinkButton>
      }
    />
  );
}

function LibraryContent() {
  const styles = useInsightStyles();
  const auth = useAuth();
  const [filters, update] = useUrlStates(FILTERS);
  // The search text is typed, so it lives in the field and reaches the URL when typing pauses (see `useUrlTextState`).
  const searchField = useUrlTextState('q', SEARCH);
  const q = searchField.value;
  const search = useDebouncedValue(q.trim(), 300);
  const params = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(filters.lifecycle !== 'all' ? { lifecycle: filters.lifecycle } : {}),
      ...(search ? { q: search } : {}),
    }),
    [filters.lifecycle, search],
  );
  const pages = useApiPages(
    'skills.list',
    { query: params },
    { enabled: auth.status === 'ready', placeholderData: keepPreviousData },
  );
  const active = filters.lifecycle !== 'all' || q.trim() !== '';
  // What the answer on screen was asked for: the search text is sent after a pause, the lifecycle at once.
  const asked = filters.lifecycle !== 'all' || search !== '';
  const skills = useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);
  const clear = (): void => {
    searchField.set('');
    update({ lifecycle: 'all' });
  };

  return (
    <QueryBoundary
      query={pagedBoundary(pages)}
      subject="The skill library"
      skeleton={<LibrarySkeleton />}
      // The empty library is for the answer to an unfiltered request. While the answer of a search that found nothing is
      // still on screen (just cleared, the full list on its way) the form must stay, or it is gone while typing.
      isEmpty={(value) =>
        !asked && !pages.isPlaceholderData && (value.pages[0]?.items.length ?? 0) === 0
      }
      empty={<EmptyLibrary />}
    >
      {(_data, meta) => (
        <div className={mergeClasses(styles.page, meta.isRefreshing && styles.busy)}>
          <form
            role="search"
            aria-label="Filter skills"
            className={styles.toolbar}
            onSubmit={(event) => event.preventDefault()}
          >
            <Field label="Search" className={styles.field}>
              <Input
                {...searchField.inputProps}
                type="search"
                placeholder="Name, workload or description"
                contentBefore={<SearchRegular aria-hidden="true" />}
                maxLength={MAX_SEARCH}
              />
            </Field>
            <Field label="Lifecycle state" className={styles.field}>
              <Select
                className={styles.select}
                value={filters.lifecycle}
                onChange={(_event, next) =>
                  update({ lifecycle: next.value as (typeof LIFECYCLE_VALUES)[number] })
                }
              >
                <option value="all">Any state</option>
                {SKILL_LIFECYCLE.map((state) => (
                  <option key={state} value={state}>
                    {SKILL_LIFECYCLE_LABELS[state]}
                  </option>
                ))}
              </Select>
            </Field>
            <Button appearance="subtle" disabled={!active} onClick={clear}>
              Clear filters
            </Button>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={pages.isFetching}
              onClick={() => void pages.refetch()}
            >
              {pages.isFetching && !pages.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          </form>
          <Notice variant="model-estimate" compact title="Estimates">
            Confidence and effectiveness are model estimates. A skill is never published
            automatically: each lifecycle step needs a person with the right role.
          </Notice>
          <span role="status" aria-live="polite" className={styles.meta}>
            {skills.length === 0
              ? 'No loaded skill matches.'
              : `Showing ${skills.length} ${skills.length === 1 ? 'skill' : 'skills'}${pages.hasNextPage ? '; more are available' : ''}.`}
          </span>
          {skills.length === 0 ? (
            <EmptyState
              compact
              headingLevel={2}
              icon={<SearchRegular />}
              title="No skill matches the filters"
              description="Try another word, or show every lifecycle state."
              action={
                <Button appearance="outline" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <ul className={styles.list} aria-label="Skills">
              {skills.map((skill) => (
                <SkillCard key={skill.id} skill={skill} headingLevel={2} />
              ))}
            </ul>
          )}
          {pages.hasNextPage ? (
            <div className={styles.actions}>
              <Button
                appearance="outline"
                disabled={pages.isFetchingNextPage}
                onClick={() => void pages.fetchNextPage()}
              >
                {pages.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          ) : null}
          {pages.isFetchNextPageError ? (
            <p role="alert" className={styles.text}>
              The next page could not be loaded. Try “Load more” again.
            </p>
          ) : null}
        </div>
      )}
    </QueryBoundary>
  );
}

/**
 * SkillDNA Library (`/skills`): governed, reusable investigation skills with their lifecycle state, version, validation
 * status and estimated confidence. `?lifecycle=` and `?q=` filter on the server, and results load page by page on request.
 */
export function SkillLibraryPage() {
  return (
    <>
      <PageHeader
        title="SkillDNA Library"
        description="Governed, reusable investigation skills distilled from validated reasoning."
        help={PAGE_HELP}
      />
      <PermissionGate
        permission="skill:read"
        subject="the SkillDNA Library"
        grantedTo="Every role"
        skeleton={<LibrarySkeleton />}
      >
        <LibraryContent />
      </PermissionGate>
    </>
  );
}
