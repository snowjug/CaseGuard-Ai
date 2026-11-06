'use client';

import type { CoachingItem, CoachingReport } from '@caseguard/schemas';
import {
  BentoGrid,
  BentoItem,
  BlurFade,
  Card,
  Panel,
  ProvenanceBadge,
  RelativeTime,
  StatusBadge,
  UiLink,
  cg,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ArrowRightIcon } from 'lucide-react';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { HindsightBadge } from './HindsightBadge';
import { useLook } from './look';

const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

const useStyles = makeStyles({
  fill: { height: '100%', boxSizing: 'border-box' },
  // Retrospective content is framed apart from the decision-time views: a dashed edge, never a status colour.
  frame: {
    gap: cg.space[3],
    border: `1px dashed ${cg.borderControl}`,
  },
  list: { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyleType: 'none' },
  item: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    paddingBlock: cg.space[4],
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0, paddingTop: 0 },
    ':last-child': { paddingBottom: 0 },
  },
  label: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    alignSelf: 'flex-start',
    minHeight: '24px',
    color: cg.textLink,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    textDecorationLine: 'none',
    ':hover': { textDecorationLine: 'underline' },
    '@media (pointer: coarse)': { minHeight: '44px' },
  },
});

function Item({ item, caseId }: { item: CoachingItem; caseId: string }) {
  const styles = useStyles();
  const look = useLook();
  return (
    <li className={styles.item}>
      <h3 className={look.title}>{item.title}</h3>
      <ClampedText text={item.detail} lines={4} label={`detail of ${item.title}`} />
      <EvidenceLinkList
        caseId={caseId}
        links={item.evidence}
        label={`Evidence for ${item.title}`}
      />
      {item.skillId ? (
        <UiLink href={`/skills/${encodeURIComponent(item.skillId)}`} className={styles.link}>
          Open the related skill
          <ArrowRightIcon aria-hidden="true" />
        </UiLink>
      ) : null}
    </li>
  );
}

function Section({
  title,
  description,
  items,
  caseId,
  empty,
}: {
  title: string;
  description?: string;
  items: readonly CoachingItem[];
  caseId: string;
  empty: string;
}) {
  const styles = useStyles();
  const look = useLook();
  return (
    <Panel title={title} {...(description ? { description } : {})} className={styles.fill}>
      {items.length === 0 ? (
        <p className={look.text}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <Item key={item.title} item={item} caseId={caseId} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export interface CoachingViewProps {
  report: CoachingReport;
  caseId: string;
  /** True when a time cursor is set: the report ignores it, and the page says so. */
  cursorIgnored: boolean;
}

/**
 * The "Coaching" tab. It is a retrospective review of the finished case, so it is framed as hindsight (dashed outline
 * and a label) and kept apart from the decision-time views. The tone is constructive; nothing ranks or rates a person.
 */
export function CoachingView({ report, caseId, cursorIgnored }: CoachingViewProps) {
  const styles = useStyles();
  const look = useLook();
  return (
    <div className={look.page}>
      <BlurFade>
        <Card role="group" aria-label="Retrospective review" padding="md" className={styles.frame}>
          <HindsightBadge />
          <p className={styles.label}>
            Retrospective review: uses the whole record, including the outcome
          </p>
          <p className={look.text}>
            {cursorIgnored
              ? 'This review looks back at the finished case, so it does not follow the time cursor. Some statements say "in hindsight": they use information that was not available when the decision was made, to calibrate and never to judge it.'
              : 'This review looks back at the finished case. Statements that say "in hindsight" use information that was not available when the decision was made, to calibrate and never to judge it.'}
          </p>
          <p className={look.text}>{report.summary}</p>
          <div className={look.row}>
            <ProvenanceBadge kind="estimated" />
            <span className={look.meta}>
              Generated <RelativeTime value={report.generatedAt} />
            </span>
          </div>
        </Card>
      </BlurFade>
      <p className={look.meta}>
        <span className={look.strong}>How to read this.</span> {report.notice}
      </p>
      <BentoGrid>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={1} className={styles.fill}>
            <Section
              title="What went well"
              description="Start from what worked."
              items={report.wentWell}
              caseId={caseId}
              empty="Nothing stood out as especially strong in what was recorded."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={2} className={styles.fill}>
            <Section
              title="Most important missed opportunity"
              description="The one change that would have helped most."
              items={report.missedOpportunity ? [report.missedOpportunity] : []}
              caseId={caseId}
              empty="No single missed opportunity stood out."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={3} className={styles.fill}>
            <Section
              title="Evidence quality"
              items={report.evidenceQuality}
              caseId={caseId}
              empty="Nothing to add on evidence quality."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={3} className={styles.fill}>
            <Section
              title="Reasoning"
              items={report.reasoningImprovements}
              caseId={caseId}
              empty="Nothing to add on reasoning."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={4} className={styles.fill}>
            <Section
              title="Communication"
              items={report.communicationImprovements}
              caseId={caseId}
              empty="Nothing to add on communication."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={4} className={styles.fill}>
            <Section
              title="Customer effort"
              items={report.customerEffortImprovements}
              caseId={caseId}
              empty="Nothing to add on customer effort."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12}>
          <BlurFade index={5}>
            <Section
              title="Recommended next action"
              items={report.recommendedNextAction ? [report.recommendedNextAction] : []}
              caseId={caseId}
              empty="No next action is recommended."
            />
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.fill}>
            <Panel
              title="Relevant skills"
              description="Reusable fixes that apply to a case like this."
              className={styles.fill}
            >
              {report.relevantSkills.length === 0 ? (
                <p className={look.text}>No published skill matched this case.</p>
              ) : (
                <ul className={styles.list}>
                  {report.relevantSkills.map((skill) => (
                    <li key={skill.skillId} className={styles.item}>
                      <UiLink
                        href={`/skills/${encodeURIComponent(skill.skillId)}`}
                        className={styles.link}
                      >
                        {skill.name}
                      </UiLink>
                      <p className={look.meta}>
                        Match {formatProbability(skill.matchScore, 0)} (estimate)
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </BlurFade>
        </BentoItem>
        <BentoItem span={12} spanLg={6}>
          <BlurFade index={5} className={styles.fill}>
            <Panel
              title="Confidence and limitations"
              description="How far to trust this review."
              className={styles.fill}
            >
              <div className={look.row}>
                <StatusBadge
                  status="neutral"
                  label={`Confidence: ${CONFIDENCE_LABELS[report.confidence.level]}`}
                />
              </div>
              <p className={look.text}>{report.confidence.rationale}</p>
              <ul className={look.bullets}>
                {report.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </Panel>
          </BlurFade>
        </BentoItem>
      </BentoGrid>
    </div>
  );
}
