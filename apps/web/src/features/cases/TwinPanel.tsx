'use client';

import {
  PARTICIPANT_ROLE_LABELS,
  TWIN_SECTIONS,
  TWIN_SECTION_LABELS,
  type DigitalTwin,
  type TwinField,
  type TwinSection,
} from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  Panel,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatNumber,
  formatProbability,
} from '@caseguard/ui';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DocumentBulletListRegular } from '@fluentui/react-icons';
import { useMemo } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { LaterDecisionsNote } from '../../components/case/as-of';
import { METHOD_LABELS, REVIEW_STATE_LABELS, countOf } from '../../components/case/labels';
import { caseHref } from '../../lib/deep-links';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
    minWidth: 0,
  },
  label: {
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
  },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    margin: 0,
    color: cg.textMuted,
    fontSize: tokens.fontSizeBase200,
  },
  sources: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase200,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
  },
  count: { color: cg.textMuted, fontWeight: tokens.fontWeightRegular, marginLeft: cg.space[2] },
  nothing: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
  person: { margin: 0, color: cg.text, fontSize: tokens.fontSizeBase300 },
  intro: { margin: 0, color: cg.textSecondary, fontSize: tokens.fontSizeBase300 },
});

/** Sections opened when the panel first shows: the problem and its impact are what a reader needs first. */
const OPEN_BY_DEFAULT: readonly TwinSection[] = ['problem_statement', 'customer_impact'];

const MAX_SOURCES = 3;

function sourceHref(caseId: string, eventId: string, asOf: string | null): string {
  const query = `?sel=${encodeURIComponent(eventId)}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''}`;
  return `${caseHref(caseId, 'timeline')}${query}`;
}

function FieldRow({
  field,
  caseId,
  asOf,
}: {
  field: TwinField;
  caseId: string;
  asOf: string | null;
}) {
  const styles = useStyles();
  const review = REVIEW_STATE_LABELS[field.reviewStatus];
  const events = [
    ...new Set(field.sourceRefs.flatMap((ref) => (ref.eventId ? [ref.eventId] : []))),
  ];
  return (
    <li className={styles.field}>
      <p className={styles.label}>{field.label}</p>
      <ExpandableText text={field.display} lines={3} label={`${field.label} value`} />
      <p className={styles.meta}>
        <span>Confidence {formatProbability(field.confidence)} (estimate)</span>
        <span>{METHOD_LABELS[field.method]}</span>
        {field.observedAt ? <span>Observed {formatDateTimeUtc(field.observedAt)}</span> : null}
        <StatusBadge status={review.status} label={review.label} size="small" />
      </p>
      {events.length > 0 ? (
        <ul className={styles.sources} aria-label={`Sources of ${field.label}`}>
          <li>Source:</li>
          {events.slice(0, MAX_SOURCES).map((eventId) => (
            <li key={eventId}>
              <UiLink href={sourceHref(caseId, eventId, asOf)} className={styles.link}>
                Event {eventId}
              </UiLink>
            </li>
          ))}
          {events.length > MAX_SOURCES ? <li>+{events.length - MAX_SOURCES} more</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

export interface TwinPanelProps {
  caseId: string;
  twin: DigitalTwin;
  asOf: string | null;
}

/** Participants are not extracted fields: the twin lists them (synthetic roles and aliases) next to the fields. */
function ParticipantList({ twin }: { twin: DigitalTwin }) {
  const styles = useStyles();
  if (twin.participants.length === 0) {
    return <p className={styles.nothing}>No participants are known yet.</p>;
  }
  return (
    <ul className={styles.list} aria-label="Participants">
      {twin.participants.map((person) => (
        <li key={person.id} className={styles.field}>
          <p className={styles.label}>{PARTICIPANT_ROLE_LABELS[person.role]}</p>
          <p className={styles.person}>{person.alias}</p>
          <p className={styles.meta}>
            <span>{countOf(person.eventCount, 'event')}</span>
            {person.firstSeenAt ? (
              <span>First seen {formatDateTimeUtc(person.firstSeenAt)}</span>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The digital twin: the case as structured sections (problem, impact, scope, observations, actions, decisions, ...).
 * Every value shows its confidence (an estimate), how it was extracted, when it became known, its review status and the
 * source events it came from. With a time cursor set the API returns only what was known then.
 */
export function TwinPanel({ caseId, twin, asOf }: TwinPanelProps) {
  const styles = useStyles();
  const bySection = useMemo(() => {
    const groups = new Map<TwinSection, TwinField[]>();
    for (const field of twin.fields) {
      const list = groups.get(field.section);
      if (list) list.push(field);
      else groups.set(field.section, [field]);
    }
    return groups;
  }, [twin.fields]);
  const countOfSection = (section: TwinSection): number =>
    section === 'participants' ? twin.participants.length : (bySection.get(section)?.length ?? 0);
  const sections = TWIN_SECTIONS.filter((section) => countOfSection(section) > 0 || !asOf);
  const filled = sections.filter((section) => countOfSection(section) > 0).length;

  return (
    <Panel
      title="Digital twin"
      level={2}
      description={
        asOf
          ? twin.asOf
            ? `The case as structured from what was known up to ${formatDateTimeUtc(twin.asOf)}, the last event recorded by the moment you chose.`
            : 'The case as structured from what was known at the moment you chose.'
          : 'The case as structured sections, each value traced to its source.'
      }
      help="The digital twin turns the raw events into sections such as the problem statement, scope, observations and decisions. Each value keeps its source reference, an estimated confidence, how it was extracted, the time it became known and its review status. Nothing here is typed in by hand."
    >
      {twin.fields.length === 0 && twin.participants.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<DocumentBulletListRegular />}
          title="Nothing was known yet"
          description="No fields had been extracted by this moment. Move the time cursor later."
        />
      ) : (
        <>
          <p className={styles.intro}>
            {countOf(twin.fields.length, 'field')} in {countOf(filled, 'section')}
            {twin.withheldFutureEventCount > 0
              ? `. ${countOf(twin.withheldFutureEventCount, 'later event')} withheld.`
              : '.'}
          </p>
          {asOf ? <LaterDecisionsNote /> : null}
          <Accordion
            multiple
            collapsible
            defaultOpenItems={OPEN_BY_DEFAULT.filter((section) => bySection.has(section))}
          >
            {sections.map((section) => {
              const fields = bySection.get(section) ?? [];
              return (
                <AccordionItem key={section} value={section}>
                  <AccordionHeader as="h3" expandIconPosition="end">
                    {TWIN_SECTION_LABELS[section]}
                    <span className={styles.count}>{formatNumber(countOfSection(section))}</span>
                  </AccordionHeader>
                  <AccordionPanel>
                    {section === 'participants' ? (
                      <ParticipantList twin={twin} />
                    ) : fields.length === 0 ? (
                      <p className={styles.nothing}>
                        No values were extracted for this section from the case text.
                      </p>
                    ) : (
                      <ul className={styles.list} aria-label={TWIN_SECTION_LABELS[section]}>
                        {fields.map((field) => (
                          <FieldRow key={field.id} field={field} caseId={caseId} asOf={asOf} />
                        ))}
                      </ul>
                    )}
                  </AccordionPanel>
                </AccordionItem>
              );
            })}
          </Accordion>
          <Notice variant="model-estimate" compact title="Estimates">
            Confidence values are model estimates from rules and patterns over the case text. They
            are not statistical truth.
          </Notice>
        </>
      )}
    </Panel>
  );
}
