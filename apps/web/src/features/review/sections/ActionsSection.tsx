'use client';

import type { Permission } from '@caseguard/schemas';
import {
  AnimatedList,
  Button,
  EmptyState,
  IconButton,
  LoadingSkeleton,
  ProvenanceBadge,
  StatusBadge,
  cg,
  copyText,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDownIcon, CircleCheckIcon, CopyIcon, InfoIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { QueryErrorState } from '../../../components/common/QueryErrorState';
import { useToast } from '../../../lib/toast';
import { ClampedText } from '../../quality/ClampedText';
import { EvidenceChips } from '../evidence/EvidenceChips';
import { useLinkTitles } from '../evidence/useProvenance';
import type { Handle } from '../hooks';
import { GENERAL_GUIDANCE, fixText, type NextAction } from '../model/actions';
import { methodNotes } from '../model/method';
import { joinWords, plural } from '../model/words';
import { useRunHandle } from '../hooks';
import { useNextActions } from '../use-next-actions';
import { PermissionPart, SectionFrame } from './shared';

/** How many fixes are listed before the rest are offered on request. */
const FIRST_SHOWN = 3;

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
  item: {
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr) auto',
    alignItems: 'start',
    columnGap: cg.space[3],
    padding: cg.space[4],
    borderRadius: cg.radius.lg,
    backgroundColor: cg.surfaceSunken,
    transitionProperty: 'background-color, transform',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    ':hover': { backgroundColor: cg.surfaceRaised },
    '@media (max-width: 639px)': { padding: cg.space[3], columnGap: cg.space[2] },
  },
  rank: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    fontVariantNumeric: 'tabular-nums',
  },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  general: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  source: { fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  more: { alignSelf: 'flex-start' },
});

function FixItem({
  index,
  action,
  titles,
}: {
  index: number;
  action: NextAction;
  titles: ReadonlyMap<string, string>;
}) {
  const styles = useStyles();
  const toast = useToast();
  const headingId = useId();
  const copy = async (): Promise<void> => {
    const ok = await copyText(fixText(action));
    if (ok) toast.success('Fix copied', { body: 'It is on your clipboard.' });
    else
      toast.error('The fix could not be copied', { body: 'Select the text and copy it instead.' });
  };
  return (
    <div className={styles.item}>
      <span className={styles.rank} aria-hidden="true">
        {index + 1}
      </span>
      <article className={styles.body} aria-labelledby={headingId}>
        <div className={styles.badges}>
          <StatusBadge status={action.priorityBadge} label={action.priorityLabel} size="small" />
          <span className={styles.source}>{action.sourceLabel}</span>
          {action.alsoCoachesNext ? (
            <StatusBadge status="neutral" size="small" label="Also the coach’s next action" />
          ) : null}
        </div>
        <h3 id={headingId} className={styles.title}>
          {action.title}
        </h3>
        <ClampedText text={action.reason} lines={2} label="reason" />
        {action.suggestion ? (
          <p className={styles.text}>
            <span className={styles.strong}>Suggested:</span> {action.suggestion}
          </p>
        ) : null}
        {action.owner || action.gain ? (
          <p className={styles.meta}>
            {[
              action.owner ? `Owner: ${action.owner}` : null,
              action.gain ? `Expected gain: ${action.gain}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {action.hasEvidence ? (
          <EvidenceChips links={action.links} subject={action.title} titles={titles} max={2} />
        ) : (
          <p className={styles.general}>
            <InfoIcon aria-hidden="true" size={14} /> {GENERAL_GUIDANCE}
          </p>
        )}
      </article>
      <IconButton
        icon={<CopyIcon />}
        label={`Copy fix: ${action.title}`}
        size="sm"
        onClick={() => void copy()}
      />
    </div>
  );
}

interface UnreadPart {
  handle: Handle<unknown>;
  /** What the read is for, as a noun phrase. */
  what: string;
}

/**
 * Names, once each, the sources of the list that could not be read: those the role may not read are grouped by the
 * permission that is missing (so one missing permission is explained once), and those that failed get their own retry.
 */
function Unread({ parts }: { parts: readonly UnreadPart[] }) {
  const denied = new Map<Permission, string[]>();
  const failed: { part: UnreadPart; error: unknown }[] = [];
  for (const part of parts) {
    const source = part.handle.source;
    if (source.kind === 'denied')
      denied.set(source.permission, [...(denied.get(source.permission) ?? []), part.what]);
    else if (source.kind === 'failed') failed.push({ part, error: source.error });
  }
  return (
    <>
      {[...denied].map(([permission, whats]) => (
        <PermissionPart
          key={permission}
          permission={permission}
          what={joinWords(whats)}
          several={whats.length > 1}
        />
      ))}
      {failed.map(({ part, error }) => (
        <QueryErrorState
          key={part.what}
          compact
          subject={part.what.charAt(0).toUpperCase() + part.what.slice(1)}
          error={error}
          onRetry={part.handle.retry}
          retrying={part.handle.fetching}
        />
      ))}
    </>
  );
}

/**
 * Fix first: the highest-value recommendations in one ranked list, from the quality improvements, the warnings still
 * open, the coach's recommended next action and the best-ranked diagnostic steps. The first three are shown with their
 * reason, a priority, an owner where the data says who, the expected gain where there is one, their evidence as chips
 * and a button that copies the fix; a recommendation with no evidence says so. A source the role may not read, or that
 * failed, is named, and the rest of the list stands.
 */
export function ActionsSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const { model, handles, loading, warningsRead } = useNextActions(caseId);
  const run = useRunHandle(caseId);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const shown = expanded ? model.items : model.items.slice(0, FIRST_SHOWN);
  const titles = useLinkTitles(
    caseId,
    shown.flatMap((item) => item.links),
  );
  const notes = methodNotes('actions', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: null,
    path: null,
  });
  const rest = model.items.length - shown.length;
  return (
    <SectionFrame
      id="next-actions"
      title="Fix first"
      description="The changes that would help most, most urgent first."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
    >
      <div className={styles.stack}>
        <Unread
          parts={[
            { handle: handles.quality, what: 'the quality improvements' },
            { handle: handles.coaching, what: 'the coach’s suggestion' },
            { handle: handles.warnings, what: 'the warnings' },
            { handle: handles.ranking, what: 'the ranked diagnostic steps' },
          ]}
        />
        {loading && model.items.length === 0 ? (
          <LoadingSkeleton variant="card" count={3} label="Loading the fixes" />
        ) : model.items.length === 0 ? (
          <EmptyState
            compact
            icon={<CircleCheckIcon />}
            title="Nothing to fix"
            description="The analysis has no recommendation for this case. That is a good sign, not an error."
          />
        ) : (
          <>
            <div id={listId}>
              <AnimatedList
                as="ol"
                aria-label="Ranked recommendations"
                className={styles.list}
                items={shown}
                getKey={(action) => action.id}
                renderItem={(action, index) => (
                  <FixItem index={index} action={action} titles={titles} />
                )}
              />
            </div>
            {model.items.length > FIRST_SHOWN ? (
              <Button
                variant="ghost"
                size="sm"
                className={styles.more}
                aria-expanded={expanded}
                aria-controls={listId}
                icon={<ChevronDownIcon />}
                iconPosition="end"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded
                  ? `Show only the first ${FIRST_SHOWN}`
                  : `Show ${plural(rest, 'more fix', 'more fixes')}`}
              </Button>
            ) : null}
          </>
        )}
        {warningsRead ? (
          <p className={styles.meta}>
            Warnings: {model.warnings.open} open, {model.warnings.resolved} resolved,{' '}
            {model.warnings.dismissed} dismissed.
            {model.warnings.open === 0 && model.warnings.resolved > 0
              ? ' Every warning raised while the case ran has been resolved; they stay on the quality page.'
              : ''}
          </p>
        ) : null}
        {model.noDiagnosticNote ? <p className={styles.meta}>{model.noDiagnosticNote}</p> : null}
        <p className={styles.meta}>
          Fixes are about the case and the process, never about a person. Gains are estimates.
        </p>
      </div>
    </SectionFrame>
  );
}
