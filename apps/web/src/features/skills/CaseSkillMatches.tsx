'use client';

import { EmptyState, LoadingSkeleton, Notice, Panel, ProvenanceBadge } from '@caseguard/ui';
import { MoleculeRegular } from '@fluentui/react-icons';
import { mergeClasses } from '@fluentui/react-components';
import { LinkButton } from '../../components/common/LinkButton';
import { useSkillMatchesAt } from '../quality/case-hooks';
import { PanelBoundary } from '../quality/PanelBoundary';
import { useInsightStyles } from '../quality/styles';
import { SkillMatchCard } from './SkillMatchCard';

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
 * The "SkillDNA" tab of a case: the skills that fit it at the time cursor, with the evidence for each fit. The matches
 * of another moment never stay on screen while the chosen one loads (they would claim a fit the evidence of this moment
 * does not support): the panel shows its loading state instead.
 */
export function CaseSkillMatches({
  caseId,
  asOf,
  ready = true,
  onWholeRecord,
}: CaseSkillMatchesProps) {
  const styles = useInsightStyles();
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
        <LinkButton href="/skills" appearance="outline">
          Open the SkillDNA Library
        </LinkButton>
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
        subject="The SkillDNA matches"
        asOf={asOf}
        onWholeRecord={onWholeRecord}
        skeleton={<LoadingSkeleton variant="list" count={2} label="Loading SkillDNA matches" />}
        isEmpty={(data) => data.items.length === 0}
        empty={
          <EmptyState
            compact
            headingLevel={3}
            icon={<MoleculeRegular />}
            title="No skill fits this case"
            description={
              asOf
                ? 'No published skill matches what was known at this moment. Move the cursor later, or clear it.'
                : 'No published or validated skill matches this case yet. Skills are extracted from an accepted counterfactual path and then governed through review.'
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
