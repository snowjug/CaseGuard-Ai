'use client';

import {
  ButtonLink,
  EmptyState,
  LoadingSkeleton,
  Notice,
  Panel,
  ProvenanceBadge,
  cg,
} from '@caseguard/ui';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { PuzzleIcon } from 'lucide-react';
import { useSkillMatchesAt } from '../quality/case-hooks';
import { PanelBoundary } from '../quality/PanelBoundary';
import { SkillMatchCard } from './SkillMatchCard';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  busy: { opacity: 0.72 },
});

const HELP =
  'SkillDNA is a governed, reusable investigation plan distilled from a validated case. A match says how well a skill fits this case using only the evidence available at the time shown; the score is a model estimate. With the time cursor set, the match is recomputed from what was known then, and a skill extracted from this very case is not offered at an earlier moment (its conditions were learned partly from what happened later).';

export interface CaseSkillMatchesProps {
  caseId: string;
  asOf: string | null;
  /** False while the cursor still has to learn the case's event instants: an earlier view is not asked for yet. */
  ready?: boolean;
  /** Offered when the server refuses an earlier view for lack of budget: leave it for the whole record. */
  onWholeRecord?: () => void;
}

/**
 * The skills that fit a case at the time cursor, with the evidence for each fit (the "Skills" tab of a case's Score page).
 * The matches of another moment never stay on screen while the chosen one loads (they would claim a fit the evidence of
 * this moment does not support): the panel shows its loading state instead.
 */
export function CaseSkillMatches({
  caseId,
  asOf,
  ready = true,
  onWholeRecord,
}: CaseSkillMatchesProps) {
  const styles = useStyles();
  const query = useSkillMatchesAt(caseId, asOf, ready);
  return (
    <Panel
      title={asOf ? 'Skills that fit at this moment' : 'Skills that fit this case'}
      description={
        asOf
          ? 'Matched using only what was known at the time cursor.'
          : 'Matched using everything on record for the case.'
      }
      help={HELP}
      actions={<ProvenanceBadge kind="estimated" />}
      footer={
        <ButtonLink href="/skills" variant="secondary" icon={<PuzzleIcon />}>
          Browse skills
        </ButtonLink>
      }
    >
      {asOf ? (
        <Notice variant="info" compact title="Decision-time matching">
          Skills extracted from this case are left out at an earlier moment, because their
          conditions were learned partly from what happened later. Applying a skill is a
          present-time decision, so it is offered when the time cursor is cleared.
        </Notice>
      ) : null}
      <PanelBoundary
        query={query}
        subject="The skill matches"
        asOf={asOf}
        onWholeRecord={onWholeRecord}
        skeleton={<LoadingSkeleton variant="list" count={2} label="Loading SkillDNA matches" />}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            compact
            headingLevel={3}
            icon={<PuzzleIcon />}
            title="No skill fits this case"
            description={
              asOf
                ? 'No published skill matches what was known at this moment. Move the cursor later, or clear it.'
                : 'No published or validated skill matches this case yet. Skills come from a safer path accepted on a case’s What if page, and are then checked step by step.'
            }
          />
        }
      >
        {(data, meta) => (
          <ul
            className={mergeClasses(styles.list, meta.isRefreshing && styles.busy)}
            aria-busy={meta.isRefreshing}
          >
            {data.items.map((match) => (
              <SkillMatchCard key={match.id} match={match} caseId={caseId} requestedAsOf={asOf} />
            ))}
          </ul>
        )}
      </PanelBoundary>
    </Panel>
  );
}
