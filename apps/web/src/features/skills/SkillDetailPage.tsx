'use client';

import type { SkillDetail } from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  PageHeader,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
} from '@caseguard/ui';
import { Button, Tab, TabList, makeStyles, mergeClasses } from '@fluentui/react-components';
import { ArrowSyncRegular, MoleculeRegular } from '@fluentui/react-icons';
import { useId } from 'react';
import { LinkButton } from '../../components/common/LinkButton';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { useTabState } from '../../lib/url-state';
import { useInsightStyles } from '../quality/styles';
import { DefinitionTab } from './DefinitionTab';
import { GovernanceTab } from './GovernanceTab';
import { useSkillDetail } from './hooks';
import { LIFECYCLE_BADGES } from './labels';
import { LifecycleStepper, furthestReached } from './LifecycleStepper';
import { SkillDetailSkeleton } from './Skeleton';
import { UsageTab } from './UsageTab';
import { ValidationTab } from './ValidationTab';
import { VersionsTab } from './VersionsTab';

const TABS = ['overview', 'governance', 'versions', 'validation', 'cases'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  governance: 'Governance',
  versions: 'Versions',
  validation: 'Validation',
  cases: 'Cases',
};

const useStyles = makeStyles({
  tabs: {
    overflowX: 'auto',
    maxWidth: '100%',
    borderBottom: `1px solid ${cg.borderSubtle}`,
  },
});

const PAGE_HELP = (
  <>
    <p>
      A SkillDNA skill is a reusable investigation plan distilled from a validated case. This page
      shows where it stands in its lifecycle, what it contains, how its versions differ, how it was
      validated and where it has been used.
    </p>
    <p>
      Nothing here is automatic: every lifecycle step, proposed change and rollback is a
      person&apos;s decision, recorded with their name and reason, and approvals stay independent of
      whoever created or proposed the skill. Confidence and effectiveness are model estimates.
    </p>
  </>
);

function SkillMissing() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<MoleculeRegular />}
      title="We could not find that skill"
      description="It may have been removed, or the address may be mistyped."
      action={
        <LinkButton href="/skills" appearance="primary" icon={<MoleculeRegular />}>
          Open the SkillDNA Library
        </LinkButton>
      }
    />
  );
}

function SkillBody({
  detail,
  refreshing,
  onReload,
}: {
  detail: SkillDetail;
  refreshing: boolean;
  onReload: () => void;
}) {
  const styles = useStyles();
  const insight = useInsightStyles();
  const baseId = useId();
  const [tab, setTab] = useTabState(TABS, 'overview');
  const { skill } = detail;
  const reached = furthestReached(skill.lifecycle, detail.approvals);
  return (
    <div className={mergeClasses(insight.page, refreshing && insight.busy)} aria-busy={refreshing}>
      <Panel
        title="Where this skill stands"
        description="Its place on the lifecycle, from discovery to publication."
        help="A skill moves forward one governed step at a time, and each step needs the right role, an independent person where the four-eyes rule applies, and its gate (for example a passed full simulation test). It can be sent back to Draft for changes, or withdrawn as Deprecated or Retired."
      >
        <LifecycleStepper lifecycle={skill.lifecycle} reached={reached} />
        {detail.proposedVersion ? (
          <Notice
            variant="info"
            compact
            title="A change is waiting for a decision"
            action={
              <Button appearance="outline" onClick={() => setTab('versions')}>
                Review the proposed change
              </Button>
            }
          >
            Version {detail.proposedVersion.version} was proposed. It is never applied on its own.
          </Notice>
        ) : null}
        {detail.notices.map((notice) => (
          <Notice key={notice} variant="info" compact title={null}>
            {notice}
          </Notice>
        ))}
      </Panel>
      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_event, data) => setTab(data.value as Tab)}
          aria-label="Skill sections"
        >
          {TABS.map((value) => (
            <Tab
              key={value}
              value={value}
              id={`${baseId}-tab-${value}`}
              aria-controls={`${baseId}-panel-${value}`}
            >
              {TAB_LABELS[value]}
            </Tab>
          ))}
        </TabList>
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel-${tab}`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className={insight.page}
      >
        {tab === 'overview' ? <DefinitionTab detail={detail} /> : null}
        {tab === 'governance' ? <GovernanceTab detail={detail} onReload={onReload} /> : null}
        {tab === 'versions' ? <VersionsTab detail={detail} onReload={onReload} /> : null}
        {tab === 'validation' ? <ValidationTab detail={detail} onReload={onReload} /> : null}
        {tab === 'cases' ? <UsageTab detail={detail} /> : null}
      </div>
    </div>
  );
}

function SkillContent({ query }: { query: ReturnType<typeof useSkillDetail> }) {
  const auth = useAuth();
  if (query.isError && query.error.isNotFound) return <SkillMissing />;
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          appearance="outline"
          icon={<ArrowSyncRegular />}
          disabled={auth.status !== 'ready' || query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <QueryBoundary query={query} subject="The skill" skeleton={<SkillDetailSkeleton />}>
        {(detail, meta) => (
          <SkillBody
            detail={detail}
            refreshing={meta.isRefreshing}
            onReload={() => void query.refetch()}
          />
        )}
      </QueryBoundary>
    </>
  );
}

/**
 * SkillDNA detail (`/skills/[skillId]`): the lifecycle stepper, the skill's definition, its governance (next steps that
 * are role-gated with the reason when blocked, and every decision so far), versions with a human-readable diff, the
 * proposed change and rollback, validation runs with their scope, effectiveness and applying the skill to a case.
 * `?tab=` selects the section and `?from=` / `?to=` the two versions to compare.
 */
export function SkillDetailPage({ skillId }: { skillId: string }) {
  const { can } = useSession();
  const query = useSkillDetail(skillId, can('skill:read'));
  const skill = query.data?.skill;
  const lifecycle = skill ? LIFECYCLE_BADGES[skill.lifecycle] : null;
  return (
    <>
      <PageHeader
        title={skill?.name ?? 'SkillDNA skill'}
        description={
          skill
            ? `${skill.product} · ${skill.workload} · version ${skill.currentVersion}`
            : 'A governed, reusable investigation skill.'
        }
        help={PAGE_HELP}
        meta={
          skill && lifecycle ? (
            <>
              <StatusBadge status={lifecycle.status} label={lifecycle.label} />
              <ProvenanceBadge kind="estimated" label="Estimated confidence" />
              {skill.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
            </>
          ) : undefined
        }
        actions={
          <LinkButton href="/skills" appearance="outline" icon={<MoleculeRegular />}>
            All skills
          </LinkButton>
        }
      />
      <PermissionGate
        permission="skill:read"
        subject="the SkillDNA Library"
        grantedTo="Every role"
        skeleton={<SkillDetailSkeleton />}
      >
        <SkillContent query={query} />
      </PermissionGate>
    </>
  );
}
