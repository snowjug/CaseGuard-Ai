'use client';

import type { AuditVerification, GovernanceSettings } from '@caseguard/schemas';
import {
  BlurFade,
  Button,
  Field,
  HelpButton,
  LoadingSkeleton,
  PageHeader,
  ProvenanceBadge,
  RelativeTime,
  Select,
  Skeleton,
  cg,
  useMediaQuery,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { keepPreviousData } from '@tanstack/react-query';
import {
  ChartNoAxesColumnIcon,
  ClipboardCheckIcon,
  ClockIcon,
  DownloadIcon,
  EyeOffIcon,
  FileTextIcon,
  FlagIcon,
  HistoryIcon,
  RefreshCwIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { PermissionNeeded } from '../../components/common/PermissionNeeded';
import { QueryBoundary, type BoundaryQuery } from '../../components/common/QueryBoundary';
import { QueryErrorState } from '../../components/common/QueryErrorState';
import { StateBadge, SummaryCard } from '../../lib/advanced-view-parts';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { PROVIDER_LABELS } from '../../lib/labels';
import { useShortcut } from '../../lib/shortcuts';
import { useTabState } from '../../lib/url-state';
import { AuditPanel } from './AuditPanel';
import { ExportPanel } from './ExportPanel';
import { ModelSection } from './ModelSection';
import { OperationsPanel } from './OperationsPanel';
import { PromptsPanel } from './PromptsPanel';
import { RedactionSection } from './RedactionSection';
import { ReviewsPanel } from './ReviewsPanel';
import { RolesPanel } from './RolesPanel';
import { ActionValueSection, QualitySection } from './ScoringSections';
import { SectionNav } from './SectionNav';
import { ExportControlsSection, FlagsSection, RetentionSection } from './SimpleSections';
import { GovernanceSkeleton, SectionSkeleton } from './Skeleton';
import { GOVERNANCE_TABS, GOVERNANCE_TAB_IDS, type GovernanceTabId } from './tabs';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: cg.space[6], minWidth: 0 },
  layout: {
    display: 'grid',
    gap: cg.space[6],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    '@media (min-width: 900px)': { gridTemplateColumns: '220px minmax(0, 1fr)' },
  },
  list: {
    '@media (min-width: 900px)': {
      position: 'sticky',
      top: 'calc(var(--cg-shell-top, 84px) + 16px)',
    },
  },
  panel: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  chain: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    paddingTop: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  chainHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[1] },
  chainTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  chainAction: { marginInlineStart: 'auto' },
  chainRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  broken: { margin: 0, color: cg.text },
  brokenTitle: { color: cg.tone.unsupported.fg, fontWeight: tokens.fontWeightSemibold },
});

const TAB_ICONS: Record<GovernanceTabId, LucideIcon> = {
  model: SlidersHorizontalIcon,
  prompts: FileTextIcon,
  scoring: ChartNoAxesColumnIcon,
  retention: ClockIcon,
  redaction: EyeOffIcon,
  flags: FlagIcon,
  export: DownloadIcon,
  roles: UsersIcon,
  audit: HistoryIcon,
  reviews: ClipboardCheckIcon,
  operations: WrenchIcon,
};

const PAGE_HELP = (
  <>
    <p>
      Settings and audit is where an administrator controls how CaseGuard behaves and proves what
      happened: the model limits and prompts, how quality and action value are scored, retention,
      what is redacted and exported, who holds which role, and the audit log with its check that
      nothing was changed afterwards.
    </p>
    <p>
      Every setting is versioned. Saving needs the version you started from and a change note, so
      two people can never silently overwrite each other, and every change is audited. Each section
      says plainly whether anything enforces it today or whether it is recorded only.
    </p>
  </>
);

const CHAIN_HELP =
  'Every audit event stores the hash of the one before it and its own hash over its content, so a removed or edited event breaks the chain. Verifying walks the whole chain and recomputes every hash: any gap, edit or reordering shows up as the first sequence number that no longer matches.';

/** The most recently changed section: what changed last, when and by whom. */
function lastChange(settings: GovernanceSettings) {
  const envelopes = Object.values(settings);
  return envelopes.reduce((latest, item) =>
    Date.parse(item.updatedAt) > Date.parse(latest.updatedAt) ? item : latest,
  );
}

type VerifyQuery = BoundaryQuery<AuditVerification>;

/** The audit log's integrity check, inside the summary: intact, broken (with where), or not available. */
function AuditCheck({ verify }: { verify: VerifyQuery }) {
  const styles = useStyles();
  const headingId = useId();
  const result = verify.data;
  return (
    <div role="group" aria-labelledby={headingId} className={styles.chain}>
      <div className={styles.chainHead}>
        <h3 id={headingId} className={styles.chainTitle}>
          Audit log check
        </h3>
        <HelpButton label="About the audit log check" title="Audit log check">
          {CHAIN_HELP}
        </HelpButton>
        <span className={styles.chainAction}>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCwIcon />}
            loading={verify.isFetching}
            onClick={() => void verify.refetch()}
          >
            {verify.isFetching ? 'Verifying…' : 'Verify again'}
          </Button>
        </span>
      </div>
      {verify.isPending ? (
        <LoadingSkeleton variant="text" count={1} label="Verifying the audit log" />
      ) : verify.isError || !result ? (
        <QueryErrorState
          error={verify.error}
          subject="The audit log check"
          compact
          onRetry={() => void verify.refetch()}
          retrying={verify.isFetching}
        />
      ) : result.valid ? (
        <div className={styles.chainRow} role="status">
          <StateBadge
            status="productive"
            label="Chain intact"
            title="No event was removed, changed or reordered."
          />
          <span className={styles.text}>
            {result.detail} · checked <RelativeTime value={result.checkedAt} />
          </span>
        </div>
      ) : (
        <div role="alert">
          <p className={styles.broken}>
            <span className={styles.brokenTitle}>The audit chain is broken</span>
          </p>
          <p className={styles.text}>
            {result.detail}
            {result.firstInvalidSequence !== null
              ? ` The first event that does not match is #${result.firstInvalidSequence}.`
              : ''}{' '}
            {result.eventsChecked} events were checked <RelativeTime value={result.checkedAt} />.
            Treat the log after that point as untrusted and investigate.
          </p>
        </div>
      )}
    </div>
  );
}

function OverviewCard({
  settings,
  verify,
  canConfig,
  canAudit,
}: {
  settings: BoundaryQuery<GovernanceSettings>;
  verify: VerifyQuery;
  canConfig: boolean;
  canAudit: boolean;
}) {
  const config = settings.data;
  const provider = config?.model.value.provider;
  const broken = verify.data?.valid === false;
  let headline: ReactNode;
  let description: string;
  if (!canConfig) {
    headline = 'The audit log and reviewer decisions';
    description = 'Your role can read the audit log and reviewer decisions, not the settings.';
  } else if (config && provider) {
    headline = `${PROVIDER_LABELS[provider]} runs the analysis`;
    description =
      'The deployment chooses the provider; the settings below tighten its limits and set the rules.';
  } else if (settings.isError) {
    headline = 'The settings are not available';
    description = 'They could not be loaded. Open a section below to try again.';
  } else {
    headline = <Skeleton width="48%" height={30} />;
    description = 'Loading the settings…';
  }
  const change = config ? lastChange(config) : null;
  return (
    <SummaryCard
      title="Current setup"
      icon={<Settings2Icon />}
      tone={broken ? 'unsupported' : 'brand'}
      headline={headline}
      description={description}
      badges={
        provider === 'deterministic' ? (
          <ProvenanceBadge kind="simulated" size="medium" />
        ) : undefined
      }
      factsLabel="Current settings"
      facts={
        config && provider && change
          ? [
              { id: 'provider', label: 'AI provider', value: PROVIDER_LABELS[provider] },
              {
                id: 'model',
                label: 'Default model',
                value: config.model.value.routing.defaultModel,
                mono: true,
              },
              {
                id: 'changed',
                label: 'Settings last changed',
                value: (
                  <>
                    <RelativeTime value={change.updatedAt} /> by {change.updatedBy}
                  </>
                ),
              },
            ]
          : undefined
      }
    >
      {canAudit ? <AuditCheck verify={verify} /> : null}
    </SummaryCard>
  );
}

/** One `governance.get` serves every configuration section; each section remounts when its version changes. */
function SettingsTab({ children }: { children: (settings: GovernanceSettings) => ReactNode }) {
  const auth = useAuth();
  const settings = useApiQuery('governance.get', undefined, {
    enabled: auth.status === 'ready',
    placeholderData: keepPreviousData,
  });
  return (
    <QueryBoundary query={settings} subject="The settings" skeleton={<SectionSkeleton />}>
      {(data) => children(data)}
    </QueryBoundary>
  );
}

const versioned = (section: string, version: number): string => `${section}:${version}`;

function TabContent({ tab }: { tab: GovernanceTabId }) {
  const styles = useStyles();
  const { can } = useSession();
  const spec = GOVERNANCE_TABS.find((item) => item.id === tab) ?? GOVERNANCE_TABS[0];
  if (spec.permission && !can(spec.permission)) {
    return (
      <PermissionNeeded
        subject={spec.label}
        permission={spec.permission}
        grantedTo={spec.grantedTo}
      />
    );
  }
  switch (tab) {
    case 'model':
      return (
        <SettingsTab>
          {(s) => <ModelSection key={versioned('model', s.model.version)} envelope={s.model} />}
        </SettingsTab>
      );
    case 'prompts':
      return <PromptsPanel />;
    case 'scoring':
      return (
        <SettingsTab>
          {(s) => (
            <div className={styles.panel}>
              <QualitySection key={versioned('quality', s.quality.version)} envelope={s.quality} />
              <ActionValueSection
                key={versioned('action_value', s.action_value.version)}
                envelope={s.action_value}
              />
            </div>
          )}
        </SettingsTab>
      );
    case 'retention':
      return (
        <SettingsTab>
          {(s) => (
            <RetentionSection
              key={versioned('retention', s.retention.version)}
              envelope={s.retention}
            />
          )}
        </SettingsTab>
      );
    case 'redaction':
      return (
        <SettingsTab>
          {(s) => (
            <RedactionSection
              key={versioned('redaction', s.redaction.version)}
              envelope={s.redaction}
            />
          )}
        </SettingsTab>
      );
    case 'flags':
      return (
        <SettingsTab>
          {(s) => (
            <FlagsSection
              key={versioned('flags', s.feature_flags.version)}
              envelope={s.feature_flags}
            />
          )}
        </SettingsTab>
      );
    case 'export':
      return (
        <SettingsTab>
          {(s) => (
            <div className={styles.panel}>
              <ExportControlsSection
                key={versioned('export', s.export_controls.version)}
                envelope={s.export_controls}
              />
              <ExportPanel controls={s.export_controls.value} />
            </div>
          )}
        </SettingsTab>
      );
    case 'roles':
      return <RolesPanel />;
    case 'audit':
      return <AuditPanel />;
    case 'reviews':
      return <ReviewsPanel />;
    case 'operations':
      return <OperationsPanel />;
  }
}

function SectionList({
  tab,
  onSelect,
  wide,
}: {
  tab: GovernanceTabId;
  onSelect: (tab: GovernanceTabId) => void;
  wide: boolean;
}) {
  if (!wide) {
    return (
      <Field label="Section">
        <Select value={tab} onChange={(event) => onSelect(event.target.value as GovernanceTabId)}>
          {GOVERNANCE_TABS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <SectionNav
      aria-label="Settings and audit sections"
      idPrefix="gov-tab"
      value={tab}
      onValueChange={(id) => onSelect(id as GovernanceTabId)}
      items={GOVERNANCE_TABS.map((item) => {
        const Icon = TAB_ICONS[item.id];
        return { id: item.id, label: item.label, icon: <Icon /> };
      })}
    />
  );
}

function Body() {
  const styles = useStyles();
  const auth = useAuth();
  const { can } = useSession();
  const ready = auth.status === 'ready';
  const canConfig = can('governance:read');
  const canAudit = can('audit:read');
  const settings = useApiQuery('governance.get', undefined, {
    enabled: ready && canConfig,
    placeholderData: keepPreviousData,
  });
  const verify = useApiQuery('governance.auditVerify', undefined, {
    enabled: ready && canAudit,
  });
  const wide = useMediaQuery('(min-width: 900px)', true);
  // A reviewer cannot read the configuration but can read the audit log: open there instead of on a locked section.
  const fallback: GovernanceTabId = canConfig ? 'model' : 'audit';
  const [tab, setTab] = useTabState(GOVERNANCE_TAB_IDS, fallback);
  const move = (step: 1 | -1): void => {
    const count = GOVERNANCE_TAB_IDS.length;
    const next = GOVERNANCE_TAB_IDS[(GOVERNANCE_TAB_IDS.indexOf(tab) + step + count) % count];
    if (next) setTab(next);
  };
  useShortcut({
    id: 'governance-next',
    keys: ']',
    description: 'Next section of Settings and audit',
    group: 'Settings and audit',
    handler: () => move(1),
  });
  useShortcut({
    id: 'governance-previous',
    keys: '[',
    description: 'Previous section of Settings and audit',
    group: 'Settings and audit',
    handler: () => move(-1),
  });
  return (
    <div className={styles.page}>
      <BlurFade index={0}>
        <OverviewCard
          settings={settings}
          verify={verify}
          canConfig={canConfig}
          canAudit={canAudit}
        />
      </BlurFade>
      <BlurFade index={1}>
        <div className={styles.layout}>
          <div className={styles.list}>
            <SectionList tab={tab} onSelect={setTab} wide={wide} />
          </div>
          <div
            className={styles.panel}
            {...(wide ? { role: 'tabpanel', 'aria-labelledby': `gov-tab-${tab}` } : {})}
          >
            <TabContent tab={tab} />
          </div>
        </div>
      </BlurFade>
    </div>
  );
}

/**
 * Settings and audit (`/governance`): the current setup and the audit log's integrity check first, then the sections
 * (model, prompts, scoring, retention, redaction, feature flags, export, roles, the audit log, reviewer decisions, and the
 * AI provider and demo reset). The section is in the URL (`?tab=`). Versioned sections save with `expectedVersion` and a
 * change note; a section says whether anything enforces it or whether it is recorded only.
 */
export function GovernancePage() {
  return (
    <>
      <PageHeader
        title="Settings and audit"
        description="Model, scoring, redaction, roles and the audit log."
        help={PAGE_HELP}
      />
      <PermissionGate
        permission={['governance:read', 'audit:read']}
        subject="Settings and audit"
        grantedTo="Administrators, and reviewers for the audit log"
        skeleton={<GovernanceSkeleton />}
      >
        <Body />
      </PermissionGate>
    </>
  );
}
