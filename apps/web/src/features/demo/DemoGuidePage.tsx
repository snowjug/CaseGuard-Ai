'use client';

import { ROLE_LABELS, type DemoState, type DemoStep } from '@caseguard/schemas';
import {
  EmptyState,
  KeyValueList,
  Notice,
  PageHeader,
  Panel,
  ProvenanceBadge,
  SectionHeader,
  UiLink,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { Button, ProgressBar, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  ArrowRightRegular,
  ArrowSyncRegular,
  PersonSwapRegular,
  PlayCircleRegular,
  SlideTextRegular,
} from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { LinkButton } from '../../components/common/LinkButton';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { PROVIDER_LABELS } from '../../lib/labels';
import { usePresentation } from '../../lib/presentation';
import { useRoleSwitch } from '../../lib/presentation/use-role-switch';
import { safeInternalHref } from '../../lib/safe-href';
import { useShortcut } from '../../lib/shortcuts';
import { useSelectionState } from '../../lib/url-state';
import { DemoGuideSkeleton } from './Skeleton';
import { SeedControls } from './SeedControls';
import { StepList } from './StepList';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  busy: { opacity: 0.72 },
  actions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  progressRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[3] },
  bar: { flex: '1 1 240px', minWidth: 0 },
  count: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: 'tabular-nums',
  },
  next: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[4]}`,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `2px solid ${cg.tone.brand.solid}`,
    backgroundColor: cg.tone.brand.tint,
  },
  nextText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flex: '1 1 280px',
    minWidth: 0,
  },
  nextTitle: { margin: 0, fontSize: tokens.fontSizeBase400, fontWeight: tokens.fontWeightSemibold },
  nextMeta: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  chips: { display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  notices: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
  },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  link: { color: cg.textLink },
});

const PAGE_HELP = (
  <>
    <p>
      The Demo Guide is the 13-step story CaseGuard tells: import a case, rebuild its timeline, show
      the evidence and the competing hypotheses, find the decision forks, simulate and accept a
      better path, measure quality, turn the path into a skill, approve it with two people, import a
      second case, and show the skill applying to it.
    </p>
    <p>
      Progress is derived from what is stored, never ticked by hand, so a step is done only when its
      data exists. Each step names the role to present as, and every figure on the way is synthetic,
      simulated or estimated and is labelled that way.
    </p>
  </>
);

function Overview({
  state,
  next,
  presenting,
  onSwitch,
  switcher,
}: {
  state: DemoState;
  next: DemoStep | null;
  presenting: boolean;
  onSwitch: ReturnType<typeof useRoleSwitch>;
  switcher: boolean;
}) {
  const styles = useStyles();
  const completed = state.steps.filter((step) => step.completed).length;
  const total = state.steps.length;
  const allDone = completed === total;
  const href = next && next.enabled ? safeInternalHref(next.route) : null;
  const persona = next ? onSwitch.personaFor(next.persona) : null;
  const matches = next ? onSwitch.actingAs(next.persona) : true;
  const idLink = (path: string, label: string) => (
    <UiLink href={path} className={styles.link}>
      {label}
    </UiLink>
  );
  return (
    <Panel
      title="Progress"
      description="Derived from the data stored in this environment."
      actions={
        <span className={styles.chips}>
          <ProvenanceBadge kind="synthetic" label={state.datasetLabel} />
          {state.providerSimulated ? <ProvenanceBadge kind="simulated" /> : null}
        </span>
      }
    >
      <div className={styles.progressRow}>
        <ProgressBar
          className={styles.bar}
          value={completed}
          max={Math.max(total, 1)}
          thickness="large"
          aria-label={`Demo progress: ${completed} of ${total} steps complete`}
        />
        <span className={styles.count}>
          {completed} of {total} steps complete
        </span>
      </div>
      <KeyValueList
        columns={3}
        aria-label="Demo data"
        items={[
          {
            id: 'provider',
            label: 'AI provider',
            value: PROVIDER_LABELS[state.provider],
            hint: state.providerSimulated ? 'Simulated: no language model is called' : undefined,
          },
          {
            id: 'seeded',
            label: 'Seeded',
            value: state.seededAt ? formatDateTimeUtc(state.seededAt) : 'Not seeded',
          },
          {
            id: 'case1',
            label: 'Case One',
            value: state.caseOneId
              ? idLink(`/cases/${encodeURIComponent(state.caseOneId)}`, 'Open Case One')
              : 'Not imported yet',
          },
          {
            id: 'case2',
            label: 'Case Two',
            value: state.caseTwoId
              ? idLink(`/cases/${encodeURIComponent(state.caseTwoId)}`, 'Open Case Two')
              : 'Not imported yet',
          },
          {
            id: 'skill',
            label: 'Story skill',
            value: state.skillId
              ? idLink(`/skills/${encodeURIComponent(state.skillId)}`, 'Open the skill')
              : 'Not generated yet',
          },
        ]}
      />
      {next ? (
        <div className={styles.next} role="group" aria-label="Next step">
          <div className={styles.nextText}>
            <p className={styles.nextTitle}>
              {allDone ? 'Every step is done. Last step: ' : 'Next: '}
              {next.title}
            </p>
            <p className={styles.nextMeta}>
              Present as {ROLE_LABELS[next.persona]}
              {matches ? ' · you are acting as this role' : ''}
            </p>
            {!next.enabled && next.lockedReason ? (
              <p className={styles.nextMeta}>{next.lockedReason}</p>
            ) : null}
          </div>
          {!presenting && switcher && !matches && persona ? (
            <Button
              appearance="outline"
              icon={<PersonSwapRegular />}
              onClick={() => onSwitch.switchTo(persona)}
            >
              {`Switch to ${persona.displayName}`}
            </Button>
          ) : null}
          {href ? (
            <LinkButton
              href={href}
              appearance="primary"
              icon={<ArrowRightRegular />}
              iconPosition="after"
              className={presenting ? 'cg-presenter-target' : undefined}
            >
              {next.actionLabel}
            </LinkButton>
          ) : (
            <Button appearance="primary" disabledFocusable>
              {next.actionLabel}
            </Button>
          )}
        </div>
      ) : null}
    </Panel>
  );
}

function Content({ state, isRefreshing }: { state: DemoState; isRefreshing: boolean }) {
  const styles = useStyles();
  const { enabled: presenting } = usePresentation();
  const roleSwitch = useRoleSwitch();
  const [selected, select] = useSelectionState('step');
  const next = state.steps.find((step) => step.isNextAction) ?? null;
  const nothingYet = state.steps.every((step) => !step.completed);

  return (
    <div
      className={mergeClasses(styles.page, isRefreshing && styles.busy)}
      aria-busy={isRefreshing}
    >
      <Overview
        state={state}
        next={next}
        presenting={presenting}
        onSwitch={roleSwitch}
        switcher={roleSwitch.available}
      />
      {nothingYet ? (
        <Notice variant="info" title="Nothing has been loaded yet">
          Start with step 1 to load the synthetic Case One, or ask an administrator to play the
          whole story from the controls below.
        </Notice>
      ) : null}
      {state.notices.length > 0 ? (
        <Notice variant="synthetic" title="Honest labels">
          <ul className={styles.notices} aria-label="What is synthetic, simulated or estimated">
            {state.notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {presenting ? (
        <Notice variant="info" compact title={null}>
          Seeding and persona controls are hidden while presenting. Use Reset in the presenter strip
          to start the story again.
        </Notice>
      ) : (
        <SeedControls />
      )}
      <section className={styles.section} aria-labelledby="demo-steps-heading">
        <SectionHeader
          id="demo-steps-heading"
          title="The story, step by step"
          description="Steps unlock in order. Open a step to see it in the product, with the role to present as."
        />
        <StepList
          steps={state.steps}
          selectedId={selected}
          onSelect={select}
          presenting={presenting}
          actingAs={roleSwitch.actingAs}
          personaFor={roleSwitch.personaFor}
          onSwitch={roleSwitch.switchTo}
        />
      </section>
    </div>
  );
}

/**
 * Demo Guide (`/demo`): the 13-step story with presenter notes, the role to present as, deep links into the product and
 * live progress derived from stored data. Administrators can seed and reset the synthetic tenant here; anyone can
 * switch presentation mode on. The selected step's notes are in the URL (`?step=`).
 */
export function DemoGuidePage() {
  const styles = useStyles();
  const auth = useAuth();
  const router = useRouter();
  const presentation = usePresentation();
  const query = useApiQuery('demo.state', undefined, {
    enabled: auth.status === 'ready',
    placeholderData: keepPreviousData,
  });
  const next = query.data?.steps.find((step) => step.isNextAction);
  const nextHref = next && next.enabled ? safeInternalHref(next.route) : null;

  useShortcut({
    id: 'demo-next',
    keys: 'n',
    description: 'Open the next demo step',
    group: 'Demo Guide',
    enabled: nextHref !== null,
    handler: () => {
      if (nextHref) router.push(nextHref);
    },
  });

  return (
    <>
      <PageHeader
        title="Demo Guide"
        description="The 13-step story, with presenter notes and live progress derived from the stored data."
        help={PAGE_HELP}
        actions={
          <div className={styles.actions}>
            <Button
              appearance={presentation.enabled ? 'outline' : 'primary'}
              icon={presentation.enabled ? <SlideTextRegular /> : <PlayCircleRegular />}
              aria-pressed={presentation.enabled}
              onClick={presentation.toggle}
            >
              {presentation.enabled ? 'Exit presentation mode' : 'Start presentation mode'}
            </Button>
            <Button
              appearance="outline"
              icon={<ArrowSyncRegular />}
              disabled={auth.status !== 'ready' || query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching && !query.isPending ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        }
      />
      <QueryBoundary
        query={query}
        subject="The demo guide"
        skeleton={<DemoGuideSkeleton />}
        isEmpty={(state) => state.steps.length === 0}
        empty={
          <EmptyState
            headingLevel={2}
            icon={<PlayCircleRegular />}
            title="The demo guide has no steps"
            description="The API returned no steps for this environment. Reload the page; if it persists, the demo guide is not available in this build."
            action={
              <Button appearance="primary" onClick={() => void query.refetch()}>
                Reload
              </Button>
            }
          />
        }
      >
        {(state, meta) => <Content state={state} isRefreshing={meta.isRefreshing} />}
      </QueryBoundary>
    </>
  );
}
