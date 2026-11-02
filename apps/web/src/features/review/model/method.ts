import { formatDateTimeUtc } from '@caseguard/ui';
import type {
  AnalysisRun,
  CaseDetail,
  CoachingReport,
  QualityAssessment,
} from '@caseguard/schemas';
import { describeProducer } from './verdict';
import type { PathModel } from './paths';
import { plural } from './words';

/**
 * "How this was calculated", in plain language. Each part of the review has its own note, and one note covers the whole
 * review. The words here are the ones an ordinary user knows: decision point, possible cause, better-supported path,
 * evidence, reusable skill, case quality, avoidable support effort.
 */
export type MethodSection =
  'overall' | 'verdict' | 'chronology' | 'decisions' | 'paths' | 'actions' | 'learning';

export interface MethodNote {
  heading: string;
  paragraphs: string[];
  /** Label and value pairs, for example each quality area and its weight. */
  facts: { label: string; value: string }[];
}

export interface MethodContext {
  run: AnalysisRun | null;
  quality: QualityAssessment | null;
  /** True when the role may not read case quality, so the notes say why it is not described in full. */
  qualityDenied?: boolean;
  coaching: CoachingReport | null;
  detail: CaseDetail | null;
  path: PathModel | null;
}

const percent = (weight: number): string => `${Math.round(weight * 1000) / 10}%`;

function qualityNote(quality: QualityAssessment | null, denied = false): MethodNote {
  if (!quality) {
    return {
      heading: 'Case quality',
      paragraphs: [
        'Case quality is an estimate from 0 to 100 that checks the written record of the case in six areas and combines them using fixed weights.',
        ...(denied ? ['It is not shown here because your role cannot read it.'] : []),
      ],
      facts: [],
    };
  }
  const paragraphs = [
    'Case quality is an estimate from 0 to 100. It checks the written record of the case in six areas and combines them using the weights below.',
    `Specific problems found in the record take points off: ${plural(quality.penalties.length, 'problem')}, ${quality.totalPenaltyPoints} points in total${
      quality.penaltyCapApplied ? ' (limited by the cap on penalties)' : ''
    }. The plausible range is wider where the record could not settle a check.`,
    `Scored with configuration version ${quality.configVersion}. It is decision support for a human review, never a verdict about a person.`,
  ];
  return {
    heading: 'Case quality',
    paragraphs,
    facts: quality.dimensions.map((dimension) => ({
      label: dimension.label,
      value: `${percent(dimension.weight)} of the score`,
    })),
  };
}

function producedNote(ctx: MethodContext): MethodNote {
  const producer = describeProducer(ctx.run);
  const paragraphs = [producer.sentence];
  const facts: MethodNote['facts'] = [];
  if (ctx.run) {
    facts.push(
      { label: 'Analysis run', value: ctx.run.id },
      {
        label: 'Completed',
        value: ctx.run.completedAt ? formatDateTimeUtc(ctx.run.completedAt) : 'Not completed',
      },
      {
        label: 'Knowledge pack',
        value: `${ctx.run.knowledgePackId} ${ctx.run.knowledgePackVersion}`,
      },
      { label: 'Provider', value: `${ctx.run.provider} (${ctx.run.model})` },
    );
  }
  return { heading: 'Who produced it', paragraphs, facts };
}

const REVIEW_SENTENCE: Record<PathModel['review']['state'], string> = {
  pending: 'has not yet reviewed this path',
  confirmed: 'accepted this path',
  corrected: 'accepted this path with a correction',
  rejected: 'rejected this path',
};

export function methodNotes(section: MethodSection, ctx: MethodContext): MethodNote[] {
  switch (section) {
    case 'verdict':
      return [
        qualityNote(ctx.quality, ctx.qualityDenied),
        {
          heading: 'The earliest important missed moment',
          paragraphs: [
            'It is the first moment where the analysis found a better-supported step that was available from what was known at that time. It is judged only from the record up to then.',
          ],
          facts: [],
        },
        {
          heading: 'Avoidable support effort',
          paragraphs: [
            'Avoidable support effort estimates how much of the work on the case could have been saved. It is an estimate with its own range, not a measured figure.',
          ],
          facts: [],
        },
      ];
    case 'chronology':
      return [
        {
          heading: 'Key events and waits',
          paragraphs: [
            'Key events are the first and last event, every event where a decision point was found, escalations and their answers, the validation of the fix and the resolution.',
            'A meaningful wait is a gap the analysis flagged as a delay. Its length is measured from the two timestamps, and the sentence says who was waiting from the sides the two events came from. All times are UTC.',
          ],
          facts: [],
        },
      ];
    case 'decisions':
      return [
        {
          heading: 'Decision points',
          paragraphs: [
            'A decision point is a moment where a step was taken although a better-supported one was available.',
            'Each one is judged only from what was on record at that moment. Later events and the final resolution are never used, which is why the page lists what was not yet known. The time and effort of each choice are estimates.',
          ],
          facts: [],
        },
      ];
    case 'paths': {
      const path = ctx.path;
      const paragraphs = [
        'The better-supported path is a simulation. It replays the same decision moment with steps from the knowledge pack, using only what was known then. Nothing was executed.',
        path
          ? `It was run ${path.rollouts.count} times with uncertainty in outcomes and durations, which gives the ranges. The diagnosis was reached in ${path.rollouts.diagnosisReachedText} of those runs. “Within the simulation’s uncertainty” means the simulated range includes the recorded figure, so the simulation does not show a difference.`
          : 'It is run many times with uncertainty in outcomes and durations, which gives the ranges. “Within the simulation’s uncertainty” means the simulated range includes the recorded figure.',
        path
          ? `A reviewer ${REVIEW_SENTENCE[path.review.state]}. Confidence says how consistent the simulated runs were.`
          : 'A reviewer accepts or rejects a path with a reason. Confidence says how consistent the simulated runs were.',
      ];
      return [{ heading: 'The better-supported path', paragraphs, facts: [] }];
    }
    case 'actions':
      return [
        {
          heading: 'The list of next actions',
          paragraphs: [
            'One list, most urgent first, from four sources: quality improvements, warnings that are still open, the coach’s suggestion and the best-ranked diagnostic steps.',
            'Gains are estimates. A diagnostic step that would add no information is not listed. A recommendation with no evidence behind it says so instead of showing an invented link.',
          ],
          facts: [],
        },
      ];
    case 'learning':
      return [
        {
          heading: 'Reusable skills',
          paragraphs: [
            'A reusable skill is an investigation plan distilled from an earlier case. A match says how well it fits this case using only the evidence on record. The fit is a model estimate.',
            'The comparison of the recorded path with the skill puts the skill’s own estimated saving beside what the case recorded. The server works out every figure and the screen shows it as given. Nothing in the recorded analysis changes.',
            'A skill extracted here starts as a draft and stays one until a curator approves it. Adopting a plan records that it was adopted; it does not change the case.',
          ],
          facts: [],
        },
      ];
    case 'overall': {
      const notes: MethodNote[] = [
        producedNote(ctx),
        {
          heading: 'Estimates and simulations',
          paragraphs: [
            'An estimate is a calculated figure, not a measurement. A simulated figure comes from a what-if run, not from something that happened. Both are always labelled.',
            'Every judgement about a decision point uses only what was on record at that moment.',
          ],
          facts: [],
        },
        qualityNote(ctx.quality, ctx.qualityDenied),
      ];
      if (ctx.detail?.synthetic) {
        notes.push({
          heading: 'Synthetic data',
          paragraphs: [
            'This case is synthetic. The figures show how the method works; they are not evidence of real-world performance.',
          ],
          facts: [],
        });
      }
      if (ctx.coaching && ctx.coaching.limitations.length > 0) {
        notes.push({
          heading: 'Limits',
          paragraphs: ctx.coaching.limitations,
          facts: [],
        });
      }
      return notes;
    }
  }
}
