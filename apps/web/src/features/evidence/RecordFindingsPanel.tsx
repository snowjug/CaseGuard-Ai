'use client';

import {
  CONFLICT_CLASS_LABELS,
  PARTICIPANT_ROLE_LABELS,
  STATEMENT_MODALITY_LABELS,
  type Conflict,
  type RecordFindings,
  type SetAsideObservation,
  type TemporalFinding,
  type TemporalRule,
} from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Button,
  StatusBadge,
  cg,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { InfoIcon, ScanSearchIcon } from 'lucide-react';
import { asOfCall, asOfFresh, isRateLimited } from '../../components/case/as-of';
import { isNotAnalysedError } from '../../components/case/NotAnalysedState';
import { countOf } from '../../components/case/labels';
import { keepWithinBoundary } from '../../lib/api/boundary-placeholder';
import { useApiQuery } from '../../lib/api/hooks';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    paddingLeft: cg.space[3],
    borderLeft: `2px solid ${cg.borderSubtle}`,
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: 'anywhere',
  },
  text: {
    margin: 0,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    overflowWrap: 'anywhere',
  },
  note: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    overflowWrap: 'anywhere',
  },
  intro: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  sides: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  side: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  quote: {
    margin: 0,
    paddingLeft: cg.space[3],
    borderLeft: `3px solid ${cg.borderSubtle}`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
    overflowWrap: 'anywhere',
  },
  notice: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    padding: `${cg.space[3]} ${cg.space[1]}`,
    color: cg.textSecondary,
    fontSize: tokens.fontSizeBase300,
  },
  noticeIcon: { display: 'inline-flex', color: cg.textMuted },
});

/** What each rule that needs more than one event says, in the words a reviewer reads. */
export const SEQUENCE_RULE_LABELS: Record<TemporalRule, string> = {
  requested_never_completed: 'A request nobody answered',
  evidence_available_before_decision: 'The evidence was there before the decision',
  step_only_after_escalation: 'A step taken only after the escalation',
  recommendation_contradicted_by_earlier_observation:
    'A recommendation that an earlier result contradicted',
  failed_step_repeated: 'A step that had failed was asked for again',
  rejected_hypothesis_reused: 'A cause that was ruled out was tested again',
  customer_correction_changed_cause: 'A correction from the customer changed the leading cause',
  earliest_missed_moment: 'The earliest moment a better step was open',
};

function ConflictItem({ conflict }: { conflict: Conflict }) {
  const styles = useStyles();
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <StatusBadge
          status="uncertain"
          size="small"
          label={CONFLICT_CLASS_LABELS[conflict.class]}
        />
        <h5 className={styles.title}>{conflict.subject}</h5>
      </div>
      <ul className={styles.sides} aria-label={`The two statements about ${conflict.subject}`}>
        {conflict.sides.map((side) => (
          <li key={`${side.eventId}:${side.timestamp}`} className={styles.side}>
            <p className={styles.note}>
              {PARTICIPANT_ROLE_LABELS[side.participantRole]}, {formatDateTimeUtc(side.timestamp)},
              event {side.eventId}
            </p>
            <blockquote className={styles.quote}>
              “{side.sourceRef.excerpt ?? side.statement}”
            </blockquote>
          </li>
        ))}
      </ul>
      <p className={styles.text}>
        {conflict.favours === null
          ? 'Nothing in the record settles which of the two stands.'
          : `The record favours the ${conflict.favours === 'first' ? 'earlier' : 'second'} statement.`}
      </p>
      <p className={styles.note}>{conflict.uncertainty.note}</p>
    </li>
  );
}

function SequenceItem({ finding }: { finding: TemporalFinding }) {
  const styles = useStyles();
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <StatusBadge status="neutral" size="small" label={SEQUENCE_RULE_LABELS[finding.rule]} />
      </div>
      <p className={styles.text}>{finding.conclusion}</p>
      <p className={styles.note}>
        Known at {formatDateTimeUtc(finding.asOf)}: {finding.knownThen}
      </p>
      <p className={styles.note}>
        {countOf(finding.events.length, 'event')} named. {finding.uncertainty.note}
      </p>
    </li>
  );
}

function SetAsideItem({ note }: { note: SetAsideObservation }) {
  const styles = useStyles();
  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <StatusBadge
          status="missing"
          size="small"
          label={STATEMENT_MODALITY_LABELS[note.modality]}
        />
        <h5 className={styles.title}>{note.signalLabel}</h5>
      </div>
      <blockquote className={styles.quote}>“{note.excerpt}”</blockquote>
      <p className={styles.note}>
        Event {note.eventId}
        {note.cue ? `; the words that decided it: “${note.cue}”` : ''}
      </p>
    </li>
  );
}

export interface RecordFindingsPanelProps {
  findings: RecordFindings;
  asOf: string | null;
}

/**
 * What the record shows on its own, read with fixed rules and no model: statements of the case that cannot both stand,
 * patterns that need more than one event, and the sentences a detector read and did not count (a denial, a guess, a plan,
 * a request). The last list is the usual reason an expected signal is missing. Everything here is computed from the events
 * of the selected moment, so nothing recorded after it is named. One collapsed row of the coverage card.
 */
export function RecordFindingsPanel({ findings, asOf }: RecordFindingsPanelProps) {
  const styles = useStyles();
  const { conflicts, sequenceFindings, setAside, setAsideTotal } = findings;
  const nothing = conflicts.length === 0 && sequenceFindings.length === 0 && setAsideTotal === 0;
  return (
    <AccordionItem
      title="What the record itself shows"
      subtitle={
        asOf
          ? 'Read without a model from the events up to the selected moment.'
          : 'Read without a model from the events of the whole record.'
      }
      icon={<ScanSearchIcon />}
      headingLevel={3}
    >
      <div className={styles.stack}>
        <p className={styles.intro}>
          Found by reading the wording of the events with fixed rules, not by a model. They can miss
          what the knowledge pack does not model, and they can be wrong: each one quotes the record
          so that you can check it.
        </p>
        {nothing ? (
          <p className={styles.text}>
            No two statements contradict each other, no pattern needs more than one event, and no
            sentence was read and set aside.
          </p>
        ) : (
          <Accordion>
            <AccordionItem
              title={`Statements that disagree (${conflicts.length})`}
              headingLevel={4}
            >
              {conflicts.length === 0 ? (
                <p className={styles.text}>
                  No two statements of this case contradict each other, as far as the rules can
                  tell.
                </p>
              ) : (
                <ul className={styles.list} aria-label="Statements that disagree">
                  {conflicts.map((conflict) => (
                    <ConflictItem key={conflict.id} conflict={conflict} />
                  ))}
                </ul>
              )}
            </AccordionItem>
            <AccordionItem
              title={`Patterns across events (${sequenceFindings.length})`}
              headingLevel={4}
            >
              {sequenceFindings.length === 0 ? (
                <p className={styles.text}>No pattern that needs more than one event was found.</p>
              ) : (
                <ul className={styles.list} aria-label="Patterns across events">
                  {sequenceFindings.map((finding) => (
                    <SequenceItem key={finding.id} finding={finding} />
                  ))}
                </ul>
              )}
            </AccordionItem>
            <AccordionItem
              title={`Read but not counted (${setAside.length}${
                setAsideTotal > setAside.length ? ` of ${setAsideTotal}` : ''
              })`}
              headingLevel={4}
            >
              {setAside.length === 0 ? (
                <p className={styles.text}>No sentence was read and set aside.</p>
              ) : (
                <div className={styles.stack}>
                  <p className={styles.intro}>
                    Words a detector found and did not count, because the sentence does not state
                    the fact. This is often why an expected signal is missing.
                  </p>
                  <ul className={styles.list} aria-label="Sentences read but not counted">
                    {setAside.map((note, index) => (
                      <SetAsideItem key={`${note.eventId}:${note.signalId}:${index}`} note={note} />
                    ))}
                  </ul>
                </div>
              )}
            </AccordionItem>
          </Accordion>
        )}
      </div>
    </AccordionItem>
  );
}

export interface RecordFindingsSectionProps {
  caseId: string;
  asOf: string | null;
  /** False until the rest of the page has its data, so that this read reuses the pass the page already paid for. */
  enabled: boolean;
}

/** Fetches what the record shows for the selected moment and renders it; a failure never takes the page down. */
export function RecordFindingsSection({ caseId, asOf, enabled }: RecordFindingsSectionProps) {
  const styles = useStyles();
  const request = { params: { caseId }, query: asOf ? { asOf } : {} };
  const findings = useApiQuery(
    'recordFindings.get',
    { ...request, ...asOfCall(asOf) },
    { enabled, placeholderData: keepWithinBoundary(request), ...asOfFresh(asOf) },
  );
  if (findings.data) return <RecordFindingsPanel findings={findings.data} asOf={asOf} />;
  if (!findings.isError || isNotAnalysedError(findings.error)) return null;
  return (
    <p className={styles.notice}>
      <span aria-hidden="true" className={styles.noticeIcon}>
        <InfoIcon size={16} />
      </span>
      <span>
        {isRateLimited(findings.error)
          ? 'What the record itself shows is not shown for now: the budget for recomputing earlier moments is used up.'
          : 'What the record itself shows could not be loaded.'}
      </span>
      <Button variant="ghost" size="sm" onClick={() => void findings.refetch()}>
        Try again
      </Button>
    </p>
  );
}
