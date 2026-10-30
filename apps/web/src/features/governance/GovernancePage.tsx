'use client';

import type { GovernanceSettings } from '@caseguard/schemas';
import { PageHeader, cg, useMediaQuery } from '@caseguard/ui';
import { Field, Select, Tab, TabList, makeStyles } from '@fluentui/react-components';
import {
  ArrowDownloadRegular,
  ClipboardTaskListLtrRegular,
  ClockRegular,
  DataBarVerticalRegular,
  DocumentTextRegular,
  EyeOffRegular,
  FlagRegular,
  HistoryRegular,
  PeopleRegular,
  SettingsRegular,
  WrenchRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PermissionGate } from '../../components/common/PermissionGate';
import { PermissionNeeded } from '../../components/common/PermissionNeeded';
import { QueryBoundary } from '../../components/common/QueryBoundary';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
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
import { SectionSkeleton, GovernanceSkeleton } from './Skeleton';
import { ExportControlsSection, FlagsSection, RetentionSection } from './SimpleSections';
import { GOVERNANCE_TABS, GOVERNANCE_TAB_IDS, type GovernanceTabId } from './tabs';

const useStyles = makeStyles({
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
});

const TAB_ICONS: Record<GovernanceTabId, FluentIcon> = {
  model: SettingsRegular,
  prompts: DocumentTextRegular,
  scoring: DataBarVerticalRegular,
  retention: ClockRegular,
  redaction: EyeOffRegular,
  flags: FlagRegular,
  export: ArrowDownloadRegular,
  roles: PeopleRegular,
  audit: HistoryRegular,
  reviews: ClipboardTaskListLtrRegular,
  operations: WrenchRegular,
};

const PAGE_HELP = (
  <>
    <p>
      Governance is where an administrator controls how CaseGuard behaves and proves what happened:
      the model limits and prompts, how quality and action value are scored, retention, what is
      redacted and exported, who holds which role, and the audit log with its hash-chain check.
    </p>
    <p>
      Every setting is versioned. Saving needs the version you started from and a change note, so
      two people can never silently overwrite each other, and every change is audited. Each section
      says plainly whether anything enforces it today or whether it is recorded only.
    </p>
  </>
);

/** One `governance.get` serves every configuration section; each section remounts when its version changes. */
function SettingsTab({ children }: { children: (settings: GovernanceSettings) => ReactNode }) {
  const auth = useAuth();
  const settings = useApiQuery('governance.get', undefined, {
    enabled: auth.status === 'ready',
    placeholderData: keepPreviousData,
  });
  return (
    <QueryBoundary
      query={settings}
      subject="The governance settings"
      skeleton={<SectionSkeleton />}
    >
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
        <Select value={tab} onChange={(_event, data) => onSelect(data.value as GovernanceTabId)}>
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
    <TabList
      vertical
      selectedValue={tab}
      aria-label="Governance sections"
      onTabSelect={(_event, data) => onSelect(data.value as GovernanceTabId)}
    >
      {GOVERNANCE_TABS.map((item) => {
        const Icon = TAB_ICONS[item.id];
        return (
          <Tab key={item.id} id={`gov-tab-${item.id}`} value={item.id} icon={<Icon />}>
            {item.label}
          </Tab>
        );
      })}
    </TabList>
  );
}

function Body() {
  const styles = useStyles();
  const { can } = useSession();
  const wide = useMediaQuery('(min-width: 900px)', true);
  // A reviewer cannot read the configuration but can read the audit log: open there instead of on a locked section.
  const fallback: GovernanceTabId = can('governance:read') ? 'model' : 'audit';
  const [tab, setTab] = useTabState(GOVERNANCE_TAB_IDS, fallback);
  const move = (step: 1 | -1): void => {
    const count = GOVERNANCE_TAB_IDS.length;
    const next = GOVERNANCE_TAB_IDS[(GOVERNANCE_TAB_IDS.indexOf(tab) + step + count) % count];
    if (next) setTab(next);
  };
  useShortcut({
    id: 'governance-next',
    keys: ']',
    description: 'Next Governance section',
    group: 'Governance',
    handler: () => move(1),
  });
  useShortcut({
    id: 'governance-previous',
    keys: '[',
    description: 'Previous Governance section',
    group: 'Governance',
    handler: () => move(-1),
  });
  return (
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
  );
}

/**
 * Governance (`/governance`): configuration sections (model, prompts, scoring, retention, redaction, feature flags,
 * export), roles, the audit log with chain verification, reviewer decisions, and the AI provider and demo reset. The
 * section is in the URL (`?tab=`). Versioned sections save with `expectedVersion` and a change note; a section says
 * whether anything enforces it or whether it is recorded only.
 */
export function GovernancePage() {
  return (
    <>
      <PageHeader
        title="Governance"
        description="Configuration, roles, the audit log and reviewer decisions for this tenant."
        help={PAGE_HELP}
      />
      <PermissionGate
        permission={['governance:read', 'audit:read']}
        subject="Governance"
        grantedTo="Administrators, and reviewers for the audit log"
        skeleton={<GovernanceSkeleton />}
      >
        <Body />
      </PermissionGate>
    </>
  );
}
