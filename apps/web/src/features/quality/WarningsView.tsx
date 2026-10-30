'use client';

import {
  WARNING_CATEGORIES,
  WARNING_CATEGORY_LABELS,
  type CaseWarning,
  type WarningCategory,
} from '@caseguard/schemas';
import {
  EmptyState,
  Panel,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  type BadgeStatus,
} from '@caseguard/ui';
import { Button, Field, Select, ToggleButton } from '@fluentui/react-components';
import { CheckmarkCircleRegular } from '@fluentui/react-icons';
import { useEffect, useMemo } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { PRIORITY_BADGES } from '../../lib/labels';
import { useToast } from '../../lib/toast';
import { codecs, useSelectionState, useUrlState } from '../../lib/url-state';
import { useActorLabel } from './actors';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { explainFailure, failureText, needsReload } from './failure';
import { GatedConfirm } from './GatedConfirm';
import { useInsightStyles } from './styles';

const STATES = ['open', 'resolved', 'dismissed', 'all'] as const;
type StateFilter = (typeof STATES)[number];
const STATE_LABELS: Record<StateFilter, string> = {
  open: 'Open',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  all: 'All',
};
const STATE_CODEC = codecs.enumOf(STATES, 'open');

const CATEGORIES = ['all', ...WARNING_CATEGORIES] as const;
const CATEGORY_CODEC = codecs.enumOf(CATEGORIES, 'all');

const STATE_BADGE: Record<CaseWarning['state'], { label: string; status: BadgeStatus }> = {
  open: { label: 'Open', status: 'uncertain' },
  resolved: { label: 'Resolved', status: 'productive' },
  dismissed: { label: 'Dismissed', status: 'missing' },
};

const HELP =
  'Live warnings are specific, evidence-linked prompts raised by rules while an investigation is under way: a missing timestamp, an unsupported cause, a repeated request, a customer waiting. Each is raised once per situation and says what to do next. With the time cursor set you see the warnings that were open at that moment, exactly as the engineer would have seen them. Dismissing one records who did it and why in the audit log.';

const DISMISS_HELP =
  'Dismissing a warning records your name and your reason in the audit log, and it cannot be undone from here.';

interface DismissProps {
  caseId: string;
  warning: CaseWarning;
  /** The time cursor: a dismissal is a present-time decision, so it is not offered while looking at an earlier moment. */
  asOf: string | null;
  onStale: () => void;
}

function DismissWarning({ caseId, warning, asOf, onStale }: DismissProps) {
  const styles = useInsightStyles();
  const toast = useToast();
  const dismiss = useApiMutation('warnings.dismiss', {
    invalidate: ['warnings.list', 'timeline.get', 'cases.list', 'dashboard.commandCenter'],
  });
  const blockedReason = asOf
    ? 'You are looking at an earlier moment. A dismissal is recorded at the current time, so clear the time cursor first.'
    : null;
  return (
    <>
      <GatedConfirm
        permission="warning:dismiss"
        blockedReason={blockedReason}
        trigger={
          <Button
            appearance="outline"
            size="small"
            aria-label={`Dismiss warning: ${warning.title}`}
          >
            Dismiss
          </Button>
        }
        title="Dismiss this warning?"
        confirmLabel="Dismiss warning"
        reason={{
          label: 'Why does this warning not need action? (kept in the audit log)',
          minLength: 5,
          maxLength: 500,
          placeholder:
            'For example: the customer confirmed this by phone and it is in the next note.',
        }}
        onConfirm={async (reason) => {
          try {
            await dismiss.mutateAsync({
              params: { caseId, warningId: warning.id },
              body: { reason, expectedVersion: warning.version },
            });
            toast.success('Warning dismissed', {
              body: 'Your reason is recorded in the audit log.',
            });
          } catch (error) {
            const failure = explainFailure(error);
            if (needsReload(failure)) onStale();
            throw new Error(failureText(failure), { cause: error });
          }
        }}
      >
        <p>{warning.title}</p>
        <p>{DISMISS_HELP}</p>
      </GatedConfirm>
      {blockedReason ? <span className={styles.meta}>{blockedReason}</span> : null}
    </>
  );
}

function WarningItem({
  caseId,
  warning,
  asOf,
  selected,
  onStale,
}: {
  caseId: string;
  warning: CaseWarning;
  asOf: string | null;
  selected: boolean;
  onStale: () => void;
}) {
  const styles = useInsightStyles();
  const actor = useActorLabel();
  const priority = PRIORITY_BADGES[warning.priority];
  const state = STATE_BADGE[warning.state];
  return (
    <li
      id={`warning-${warning.id}`}
      className={styles.item}
      aria-current={selected ? 'true' : undefined}
      style={selected ? { borderColor: cg.focus, borderWidth: 2 } : undefined}
    >
      <div className={styles.itemHead}>
        <StatusBadge status={priority.status} label={priority.label} size="small" />
        <StatusBadge status={state.status} label={state.label} size="small" />
        <span className={styles.meta}>{WARNING_CATEGORY_LABELS[warning.category]}</span>
      </div>
      <h3 className={styles.itemTitle}>{warning.title}</h3>
      <ClampedText text={warning.message} lines={3} label="warning message" />
      <p className={styles.text}>
        <span className={styles.strong}>Next step:</span> {warning.suggestedAction}
      </p>
      <EvidenceLinkList
        caseId={caseId}
        links={warning.evidence}
        label={`Evidence for ${warning.title}`}
      />
      <p className={styles.meta}>
        Raised {formatDateTimeUtc(warning.raisedAt)} · rule {warning.ruleId}
      </p>
      {warning.state === 'resolved' && warning.resolvedAt ? (
        <p className={styles.meta}>
          Resolved {formatDateTimeUtc(warning.resolvedAt)}
          {warning.resolvedReason ? `: ${warning.resolvedReason}` : ''}
        </p>
      ) : null}
      {warning.state === 'dismissed' && warning.dismissal ? (
        <p className={styles.meta}>
          Dismissed by {actor(warning.dismissal.by)} on {formatDateTimeUtc(warning.dismissal.at)}:{' '}
          {warning.dismissal.reason}
        </p>
      ) : null}
      {warning.state === 'open' ? (
        <div className={styles.actions}>
          <DismissWarning caseId={caseId} warning={warning} asOf={asOf} onStale={onStale} />
        </div>
      ) : null}
    </li>
  );
}

export interface WarningsViewProps {
  caseId: string;
  asOf: string | null;
  warnings: readonly CaseWarning[];
  /** Reloads the list (after a dismissal the API refused because the warning had changed). */
  onReload: () => void;
}

/**
 * The "Live warnings" tab: the warnings of the case as they stood at the time cursor (or on the whole record), filtered
 * by state and category through the URL, with a dismissal that needs a reason and is audited. Counts are taken from the
 * list the API returned for the same boundary, never from anything later.
 */
export function WarningsView({ caseId, asOf, warnings, onReload }: WarningsViewProps) {
  const styles = useInsightStyles();
  const [state, setState] = useUrlState('wstate', STATE_CODEC);
  const [category, setCategory] = useUrlState('wcat', CATEGORY_CODEC);
  const [selection] = useSelectionState();

  const inCategory = useMemo(
    () =>
      [...warnings]
        .sort((a, b) => a.rank - b.rank)
        .filter((warning) => category === 'all' || warning.category === category),
    [warnings, category],
  );
  const counts: Record<StateFilter, number> = {
    open: inCategory.filter((warning) => warning.state === 'open').length,
    resolved: inCategory.filter((warning) => warning.state === 'resolved').length,
    dismissed: inCategory.filter((warning) => warning.state === 'dismissed').length,
    all: inCategory.length,
  };
  const visible =
    state === 'all' ? inCategory : inCategory.filter((warning) => warning.state === state);

  useEffect(() => {
    if (selection)
      document.getElementById(`warning-${selection}`)?.scrollIntoView({ block: 'center' });
  }, [selection, visible.length]);

  return (
    <Panel
      title={asOf ? 'Warnings open at this moment' : 'Warnings'}
      description={
        asOf
          ? 'As the engineer would have seen them at the cursor: later resolutions and dismissals are not yet known.'
          : 'Every warning raised while the investigation ran, with how it ended.'
      }
      help={HELP}
    >
      <div className={styles.toolbar}>
        <div role="group" aria-label="Show warnings">
          <div className={styles.actions}>
            {STATES.map((value) => (
              <ToggleButton
                key={value}
                size="small"
                checked={state === value}
                onClick={() => setState(value)}
              >
                {STATE_LABELS[value]} ({counts[value]})
              </ToggleButton>
            ))}
          </div>
        </div>
        <Field label="Category" className={styles.field}>
          <Select
            className={styles.select}
            value={category}
            onChange={(_event, next) => setCategory(next.value as (typeof CATEGORIES)[number])}
          >
            <option value="all">All categories</option>
            {WARNING_CATEGORIES.map((value: WarningCategory) => (
              <option key={value} value={value}>
                {WARNING_CATEGORY_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <span role="status" aria-live="polite" className={styles.meta}>
        {visible.length === 1 ? '1 warning shown' : `${visible.length} warnings shown`}
      </span>
      {visible.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<CheckmarkCircleRegular />}
          title={
            warnings.length === 0
              ? 'No warning was raised'
              : state === 'all'
                ? 'No warning in this category'
                : `No ${STATE_LABELS[state].toLowerCase()} warning`
          }
          description={
            warnings.length === 0
              ? 'Warnings appear when the evidence shows a delay, a missing item or an unsupported step.'
              : counts.all > 0
                ? `${counts.all} ${counts.all === 1 ? 'warning exists' : 'warnings exist'} in other states.`
                : 'Choose another category to see more.'
          }
          action={
            counts.all > 0 && state !== 'all' ? (
              <Button appearance="outline" onClick={() => setState('all')}>
                Show all {counts.all}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className={styles.list}>
          {visible.map((warning) => (
            <WarningItem
              key={warning.id}
              caseId={caseId}
              warning={warning}
              asOf={asOf}
              selected={selection === warning.id}
              onStale={onReload}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
