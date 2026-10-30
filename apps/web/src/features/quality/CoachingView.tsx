'use client';

import type { CoachingItem, CoachingReport } from '@caseguard/schemas';
import {
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDateTimeUtc,
  formatProbability,
} from '@caseguard/ui';
import { ClampedText } from './ClampedText';
import { EvidenceLinkList } from './EvidenceLinkList';
import { HindsightBadge } from './HindsightBadge';
import { useInsightStyles } from './styles';

const CONFIDENCE_LABELS = { low: 'Low', medium: 'Medium', high: 'High' } as const;

function Item({ item, caseId }: { item: CoachingItem; caseId: string }) {
  const styles = useInsightStyles();
  return (
    <li className={styles.item}>
      <h3 className={styles.itemTitle}>{item.title}</h3>
      <ClampedText text={item.detail} lines={4} label={`detail of ${item.title}`} />
      <EvidenceLinkList
        caseId={caseId}
        links={item.evidence}
        label={`Evidence for ${item.title}`}
      />
      {item.skillId ? (
        <UiLink href={`/skills/${encodeURIComponent(item.skillId)}`} className={styles.link}>
          Open the related SkillDNA
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
  const styles = useInsightStyles();
  return (
    <Panel title={title} {...(description ? { description } : {})}>
      {items.length === 0 ? (
        <p className={styles.text}>{empty}</p>
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
  const styles = useInsightStyles();
  return (
    <div className={styles.page}>
      <div className={styles.hindsight} role="group" aria-label="Retrospective review">
        <HindsightBadge />
        <p className={styles.hindsightTitle}>
          Retrospective review: uses the whole record, including the outcome
        </p>
        <p className={styles.text}>
          {cursorIgnored
            ? 'This review looks back at the finished case, so it does not follow the time cursor. Some statements say "in hindsight": they use information that was not available when the decision was made, to calibrate and never to judge it.'
            : 'This review looks back at the finished case. Statements that say "in hindsight" use information that was not available when the decision was made, to calibrate and never to judge it.'}
        </p>
        <p className={styles.text}>{report.summary}</p>
        <div className={styles.actions}>
          <ProvenanceBadge kind="estimated" />
          <span className={styles.meta}>Generated {formatDateTimeUtc(report.generatedAt)}</span>
        </div>
      </div>
      <Notice variant="info" compact title="How to read this">
        {report.notice}
      </Notice>
      <Section
        title="What went well"
        description="Start from what worked."
        items={report.wentWell}
        caseId={caseId}
        empty="Nothing stood out as especially strong in what was recorded."
      />
      <Section
        title="Most important missed opportunity"
        description="The one change that would have helped most."
        items={report.missedOpportunity ? [report.missedOpportunity] : []}
        caseId={caseId}
        empty="No single missed opportunity stood out."
      />
      <div className={styles.band}>
        <Section
          title="Evidence quality"
          items={report.evidenceQuality}
          caseId={caseId}
          empty="Nothing to add on evidence quality."
        />
        <Section
          title="Reasoning"
          items={report.reasoningImprovements}
          caseId={caseId}
          empty="Nothing to add on reasoning."
        />
      </div>
      <div className={styles.band}>
        <Section
          title="Communication"
          items={report.communicationImprovements}
          caseId={caseId}
          empty="Nothing to add on communication."
        />
        <Section
          title="Customer effort"
          items={report.customerEffortImprovements}
          caseId={caseId}
          empty="Nothing to add on customer effort."
        />
      </div>
      <Section
        title="Recommended next action"
        items={report.recommendedNextAction ? [report.recommendedNextAction] : []}
        caseId={caseId}
        empty="No next action is recommended."
      />
      <Panel
        title="Relevant SkillDNA"
        description="Governed skills that apply to a case like this."
      >
        {report.relevantSkills.length === 0 ? (
          <p className={styles.text}>No published skill matched this case.</p>
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
                <p className={styles.meta}>
                  Match {formatProbability(skill.matchScore, 0)} (estimate)
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Confidence and limitations" description="How far to trust this review.">
        <div className={styles.itemHead}>
          <StatusBadge
            status="neutral"
            label={`Confidence: ${CONFIDENCE_LABELS[report.confidence.level]}`}
          />
        </div>
        <p className={styles.text}>{report.confidence.rationale}</p>
        <ul className={styles.bullets}>
          {report.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
