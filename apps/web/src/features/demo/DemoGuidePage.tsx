'use client';

import { ROLE_LABELS, type DemoState, type DemoStep } from '@caseguard/schemas';
import {
  AccordionItem,
  BlurFade,
  Button,
  ButtonLink,
  EmptyState,
  Notice,
  PageHeader,
  ProvenanceBadge,
  RelativeTime,
  SectionHeader,
  UiLink,
  cg,
  type KeyValueItem,
} from '@caseguard/ui';
import { ProgressBar, makeStyles, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import {
  ArrowRightIcon,
  CirclePlayIcon,
  DatabaseIcon,
  PresentationIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  UserCogIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { DetailSections, SummaryCard } from '../../lib/advanced-view-parts';
import { PROVIDER_LABELS } from '../../lib/labels';
import { usePresentation } from '../../lib/presentation';
import { useRoleSwitch } from '../../lib/presentation/use-role-switch';
import { safeInternalHref } from '../../lib/safe-href';
import { useShortcut } from '../../lib/shortcuts';
import { useSelectionState } from '../../lib/url-state';
import { SeedControls } from './SeedControls';
import { DemoGuideSkeleton } from './Skeleton';
import { StepList } from './StepList';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  next: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[3]} ${cg.space[6]}`,
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: `color-mix(in srgb, ${cg.tone.brand.tint} 60%, transparent)`,
    border: `1px solid color-mix(in srgb, ${cg.tone.brand.border} 45%, transparent)`,
  },
  nextText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    flex: '1 1 280px',
    minWidth: 0,
  },
  nextTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  nextMeta: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  nextActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: cg.space[2],
    minWidth: 0,
    maxWidth: '100%',
  },
  // A person's name can be long ("Switch to Morgan Manager (synthetic)"): the label wraps instead of leaving the card.
  wrapLabel: {
    maxWidth: '100%',
    flexShrink: 1,
    paddingBlock: cg.space[2],
    whiteSpace: 'normal',
    textAlign: 'start',
    lineHeight: tokens.lineHeightBase300,
  },
  section: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  caption: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  notices: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  link: { color: cg.textLink },
});

const PAGE_HELP = (
  <>
    <p>
      The guided demo is the 13-step story CaseGuard tells: import a case, rebuild its timeline,
      show the evidence and the competing hypotheses, find the key decisions, simulate and accept a
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

function ProgressCard({
  state,
  next,
  presenting,
  onSwitch,
  switcher,
  busy,
}: {
  state: DemoState;
  next: DemoStep | null;
  presenting: boolean;
  onSwitch: ReturnType<typeof useRoleSwitch>;
  switcher: boolean;
  busy: boolean;
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
  const facts: KeyValueItem[] = [
    {
      id: 'provider',
      label: 'AI provider',
      value: PROVIDER_LABELS[state.provider],
      hint: state.providerSimulated ? 'Simulated: no language model is called' : undefined,
    },
    {
      id: 'seeded',
      label: 'Seeded',
      value: state.seededAt ? <RelativeTime value={state.seededAt} /> : 'Not seeded',
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
  ];
  return (
    <SummaryCard
      title="Progress"
      icon={<CirclePlayIcon />}
      tone={allDone ? 'productive' : 'brand'}
      headline={`${completed} of ${total} steps complete`}
      description="A step counts as done only when its data exists in this environment."
      meter={
        <ProgressBar
          value={completed}
          max={Math.max(total, 1)}
          thickness="large"
          aria-label={`Demo progress: ${completed} of ${total} steps complete`}
        />
      }
      badges={
        <>
          <ProvenanceBadge kind="synthetic" label={state.datasetLabel} size="medium" />
          {state.providerSimulated ? <ProvenanceBadge kind="simulated" size="medium" /> : null}
        </>
      }
      factsLabel="Demo environment"
      facts={facts}
      busy={busy}
    >
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
          <div className={styles.nextActions}>
            {!presenting && switcher && !matches && persona ? (
              <Button
                variant="secondary"
                icon={<UserCogIcon />}
                className={styles.wrapLabel}
                onClick={() => onSwitch.switchTo(persona)}
              >
                {`Switch to ${persona.displayName}`}
              </Button>
            ) : null}
            {href ? (
              <ButtonLink
                href={href}
                variant="primary"
                icon={<ArrowRightIcon />}
                iconPosition="end"
                className={presenting ? 'cg-presenter-target' : undefined}
              >
                {next.actionLabel}
              </ButtonLink>
            ) : (
              <Button variant="primary" disabledFocusable>
                {next.actionLabel}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </SummaryCard>
  );
}

function Content({ state, isRefreshing }: { state: DemoState; isRefreshing: boolean }) {
  const styles = useStyles();
  const { enabled: presenting } = usePresentation();
  const roleSwitch = useRoleSwitch();
  const [selected, select] = useSelectionState('step');
  const next = state.steps.find((step) => step.isNextAction) ?? null;
  const nothingYet = state.steps.every((step) => !step.completed);
  const hasNotices = state.notices.length > 0;

  return (
    <div className={styles.page} aria-busy={isRefreshing}>
      <BlurFade index={0}>
        <ProgressCard
          state={state}
          next={next}
          presenting={presenting}
          onSwitch={roleSwitch}
          switcher={roleSwitch.available}
          busy={isRefreshing}
        />
      </BlurFade>
      {nothingYet ? (
        <BlurFade index={1}>
          <Notice variant="info" title="Nothing has been loaded yet">
            Start with step 1 to load the synthetic Case One, or ask an administrator to play the
            whole story from the demo data tools below.
          </Notice>
        </BlurFade>
      ) : null}
      <BlurFade index={2}>
        <section className={styles.section} aria-labelledby="demo-steps-heading">
          <SectionHeader
            id="demo-steps-heading"
            title="The story, step by step"
            description="Steps unlock in order. Open a step to see it in the product, with the role to present as."
          />
          {presenting ? (
            <p className={styles.caption}>
              Seeding and persona controls are hidden while presenting. Use Reset in the presenter
              strip to start the story again.
            </p>
          ) : null}
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
      </BlurFade>
      {!presenting || hasNotices ? (
        <BlurFade index={3}>
          <DetailSections>
            {presenting ? null : (
              <AccordionItem
                headingLevel={2}
                icon={<DatabaseIcon />}
                title="Demo data tools"
                subtitle="Seed or reset the story. Administrators only."
              >
                <SeedControls />
              </AccordionItem>
            )}
            {hasNotices ? (
              <AccordionItem
                headingLevel={2}
                icon={<ShieldCheckIcon />}
                title="What is synthetic, simulated or estimated"
                subtitle="The honest labels behind this demo"
              >
                <ul
                  className={styles.notices}
                  aria-label="What is synthetic, simulated or estimated"
                >
                  {state.notices.map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              </AccordionItem>
            ) : null}
          </DetailSections>
        </BlurFade>
      ) : null}
    </div>
  );
}

/**
 * Guided demo (`/demo`): the 13-step story as a vertical stepper with presenter notes, the role to present as, deep links
 * into the product and live progress derived from stored data. Administrators can seed and reset the synthetic tenant
 * (in a collapsed section); anyone can switch presentation mode on. The selected step's notes are in the URL (`?step=`).
 */
export function DemoGuidePage() {
  const auth = useAuth();
  const router = useRouter();
  const presentation = usePresentation();
  const query = useApiQuery('demo.state', undefined, {
    enabled: auth.status === 'ready',
    placeholderData: keepPreviousData,
  });
  const next = query.data?.steps.find((step) => step.isNextAction);
  const nextHref = next && next.enabled ? safeInternalHref(next.route) : null;
  const refreshing = query.isFetching && !query.isPending;

  useShortcut({
    id: 'demo-next',
    keys: 'n',
    description: 'Open the next demo step',
    group: 'Guided demo',
    enabled: nextHref !== null,
    handler: () => {
      if (nextHref) router.push(nextHref);
    },
  });

  return (
    <>
      <PageHeader
        title="Guided demo"
        description="A short walk through the product, step by step, with presenter notes."
        help={PAGE_HELP}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<PresentationIcon />}
              aria-pressed={presentation.enabled}
              onClick={presentation.toggle}
            >
              {presentation.enabled ? 'Exit presentation mode' : 'Start presentation mode'}
            </Button>
            <Button
              variant="ghost"
              icon={<RefreshCwIcon />}
              loading={refreshing}
              disabledFocusable={auth.status !== 'ready' || query.isPending}
              onClick={() => void query.refetch()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
        }
      />
      <QueryBoundary
        query={query}
        subject="The guided demo"
        skeleton={<DemoGuideSkeleton />}
        isEmpty={(state) => state.steps.length === 0}
        empty={
          <EmptyState
            headingLevel={2}
            icon={<CirclePlayIcon />}
            title="The guided demo has no steps"
            description="The API returned no steps for this environment. Reload the page; if it persists, the guided demo is not available in this build."
            action={
              <Button variant="primary" onClick={() => void query.refetch()}>
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
