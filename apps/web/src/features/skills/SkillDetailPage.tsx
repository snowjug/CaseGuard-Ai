'use client';

import {
  SYNTHETIC_DATA_NOTICE,
  SYNTHETIC_EFFECTIVENESS_NOTICE,
  type SkillDetail,
} from '@caseguard/schemas';
import {
  BlurFade,
  Button,
  ButtonLink,
  EmptyState,
  IconButton,
  PageHeader,
  TabPanel,
  Tabs,
  cg,
  type TabItem,
} from '@caseguard/ui';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { GitPullRequestArrowIcon, PuzzleIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useSession } from '../../lib/auth/session';
import { useTabState } from '../../lib/url-state';
import { ApplyToCase, type AppliedRecord } from './ApplyToCase';
import { DefinitionTab } from './DefinitionTab';
import { GovernanceTab } from './GovernanceTab';
import { DemoPill, InfoPill, LifecycleBadge, StatusExplanation } from './Hints';
import { useSkillDetail } from './hooks';
import { SkillHero } from './SkillHero';
import { LIFECYCLE_LABELS } from './labels';
import { SkillDetailSkeleton } from './Skeleton';
import { UsageTab } from './UsageTab';
import { ValidationTab } from './ValidationTab';
import { VersionsTab } from './VersionsTab';

const TABS = ['overview', 'governance', 'versions', 'validation', 'cases'] as const;
type Tab = (typeof TABS)[number];

/** The order people read in: what it is, where it was used, how it was checked, how it changed, who decided. */
const TAB_ITEMS: readonly TabItem[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'cases', label: 'Cases' },
  { value: 'validation', label: 'Validation' },
  { value: 'versions', label: 'Versions' },
  { value: 'governance', label: 'Governance' },
];

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[6],
    minWidth: 0,
    paddingTop: cg.space[6],
  },
  note: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[3]} ${cg.space[4]}`,
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    backgroundColor: cg.tone.brand.tint,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 35%, transparent)`,
  },
  noteIcon: { display: 'inline-flex', flexShrink: 0, color: cg.tone.brand.fg, fontSize: '20px' },
  noteText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 260px',
  },
  noteTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  noteBody: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textSecondary,
  },
});

/** The one inline note of the page, because it asks for a decision: a proposed change waits, and it is never applied on its own. */
function ProposalNote({ version, onReview }: { version: string; onReview: () => void }) {
  const styles = useStyles();
  return (
    <div role="note" className={styles.note}>
      <span aria-hidden="true" className={styles.noteIcon}>
        <GitPullRequestArrowIcon />
      </span>
      <div className={styles.noteText}>
        <p className={styles.noteTitle}>A change is waiting for a decision</p>
        <p className={styles.noteBody}>
          Version {version} was proposed. It is never applied on its own.
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={onReview}>
        Review the proposed change
      </Button>
    </div>
  );
}

function SkillMissing() {
  return (
    <EmptyState
      headingLevel={2}
      icon={<PuzzleIcon />}
      title="We could not find that skill"
      description="It may have been removed, or the address may be mistyped."
      action={
        <ButtonLink href="/skills" variant="primary" icon={<PuzzleIcon />}>
          Browse skills
        </ButtonLink>
      }
    />
  );
}

function SkillBody({
  detail,
  refreshing,
  tab,
  setTab,
  applied,
  onReload,
}: {
  detail: SkillDetail;
  refreshing: boolean;
  tab: Tab;
  setTab: (tab: Tab) => void;
  applied: AppliedRecord | null;
  onReload: () => void;
}) {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.page, refreshing && styles.busy)} aria-busy={refreshing}>
      <BlurFade index={0}>
        <SkillHero detail={detail} />
      </BlurFade>
      {detail.proposedVersion ? (
        <BlurFade index={1}>
          <ProposalNote
            version={detail.proposedVersion.version}
            onReview={() => setTab('versions')}
          />
        </BlurFade>
      ) : null}
      <BlurFade index={2}>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as Tab)}
          items={TAB_ITEMS}
          aria-label="Skill sections"
        >
          <TabPanel value="overview" className={styles.panel}>
            <DefinitionTab detail={detail} />
          </TabPanel>
          <TabPanel value="cases" className={styles.panel}>
            <UsageTab detail={detail} applied={applied} />
          </TabPanel>
          <TabPanel value="validation" className={styles.panel}>
            <ValidationTab detail={detail} onReload={onReload} />
          </TabPanel>
          <TabPanel value="versions" className={styles.panel}>
            <VersionsTab detail={detail} onReload={onReload} />
          </TabPanel>
          <TabPanel value="governance" className={styles.panel}>
            <GovernanceTab detail={detail} onReload={onReload} />
          </TabPanel>
        </Tabs>
      </BlurFade>
    </div>
  );
}

function SkillContent({
  query,
  tab,
  setTab,
  applied,
}: {
  query: ReturnType<typeof useSkillDetail>;
  tab: Tab;
  setTab: (tab: Tab) => void;
  applied: AppliedRecord | null;
}) {
  if (query.isError && query.error.isNotFound) return <SkillMissing />;
  return (
    <QueryBoundary query={query} subject="The skill" skeleton={<SkillDetailSkeleton />}>
      {(detail, meta) => (
        <SkillBody
          detail={detail}
          refreshing={meta.isRefreshing}
          tab={tab}
          setTab={setTab}
          applied={applied}
          onReload={() => void query.refetch()}
        />
      )}
    </QueryBoundary>
  );
}

/**
 * Skill detail (`/skills/[skillId]`): where the skill stands and what it is expected to save at the top, then tabs for
 * its overview and definition, the cases it matched and was applied to, its validation runs, its versions (with a
 * human-readable diff, the proposed change and rollback) and its governance (role-gated next steps with the reason when
 * blocked, and every decision so far). `?tab=` selects the tab and `?from=` / `?to=` the two versions to compare.
 */
export function SkillDetailPage({ skillId }: { skillId: string }) {
  const { can } = useSession();
  const query = useSkillDetail(skillId, can('skill:read'));
  const [tab, setTab] = useTabState(TABS, 'overview');
  const [applied, setApplied] = useState<AppliedRecord | null>(null);
  const detail = query.data;
  const skill = detail?.skill;
  return (
    <>
      <PageHeader
        title={skill?.name ?? 'Skill'}
        description={
          skill
            ? `Reusable fix for ${skill.product} · ${skill.workload} · version ${skill.currentVersion}`
            : 'A reusable fix that worked on earlier cases.'
        }
        meta={
          skill ? (
            <>
              <InfoPill
                label={`${LIFECYCLE_LABELS[skill.lifecycle]}: what this means`}
                title={`Status: ${LIFECYCLE_LABELS[skill.lifecycle]}`}
                content={<StatusExplanation lifecycle={skill.lifecycle} showTitle={false} />}
              >
                <LifecycleBadge lifecycle={skill.lifecycle} />
              </InfoPill>
              {skill.synthetic ? (
                <DemoPill>
                  <p>{SYNTHETIC_DATA_NOTICE}</p>
                  <p>{SYNTHETIC_EFFECTIVENESS_NOTICE}</p>
                </DemoPill>
              ) : null}
            </>
          ) : undefined
        }
        actions={
          detail ? (
            <>
              <IconButton
                icon={<RefreshCwIcon />}
                label={query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
                loading={query.isFetching}
                onClick={() => void query.refetch()}
              />
              <ApplyToCase
                detail={detail}
                onApplied={(record) => {
                  setApplied(record);
                  setTab('cases');
                }}
              />
            </>
          ) : undefined
        }
      />
      <PermissionGate
        permission="skill:read"
        subject="skills"
        grantedTo="Every role"
        skeleton={<SkillDetailSkeleton />}
      >
        <SkillContent query={query} tab={tab} setTab={setTab} applied={applied} />
      </PermissionGate>
    </>
  );
}
