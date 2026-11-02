import type { EvidenceLink } from '@caseguard/schemas';
import { formatDateTimeUtc } from '@caseguard/ui';
import type { ReactNode } from 'react';
import { caseHref, evidenceLinkLabel } from '../../../lib/deep-links';
import { GENERAL_GUIDANCE, type NextAction } from '../model/actions';
import { chronologyRows, type Chronology, type ChronologyEvent } from '../model/chronology';
import type { OverlayView } from '../model/learning';
import type { PathModel } from '../model/paths';
import type { StripGeometry, StripMarker, StripShape } from '../model/strip';
import { plural } from '../model/words';
import {
  REPORT_CLAIMS_SHOWN,
  REPORT_SECTIONS,
  type ChronologyPart,
  type Part,
  type ReportModel,
  type ReportSectionId,
  type ReviewPart,
} from './model';

/**
 * The report as a document: plain semantic HTML with class names and no component library, so the same markup is read in
 * the app, printed, and written to a single file by `renderToStaticMarkup`. Every string that came from a case is a React
 * child, so it is escaped; nothing here uses `dangerouslySetInnerHTML`, and there are no scripts and no handlers.
 */

export interface ReportDocumentProps {
  report: ReportModel;
  caseId: string;
  /** The address of the app (`https://host`), so links in the document are complete wherever it is read; `''` for none. */
  origin: string;
  /**
   * True inside the app, where the page already has its own title: the document's title is then only for print, so the
   * page has one `h1` on screen and the printed report still starts with its title.
   */
  embedded?: boolean;
}

type Tone = 'good' | 'warn' | 'bad' | 'estimated' | 'simulated' | 'plain';

function Tag({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`cg-tag${tone === 'plain' ? '' : ` cg-tag--${tone}`}`}>{children}</span>;
}

const PRIORITY_TONE = { unsupported: 'bad', uncertain: 'warn', productive: 'good' } as const;

function priorityTone(badge: NextAction['priorityBadge']): Tone {
  return badge in PRIORITY_TONE ? PRIORITY_TONE[badge as keyof typeof PRIORITY_TONE] : 'plain';
}

function EvidenceList({ links, label }: { links: readonly EvidenceLink[]; label: string }) {
  return (
    <ul className="cg-evidence" aria-label={label}>
      {links.map((link) => (
        <li key={`${link.type}:${link.id}`}>{evidenceLinkLabel(link)}</li>
      ))}
    </ul>
  );
}

function Facts({ items }: { items: readonly { label: string; value: ReactNode }[] }) {
  return (
    <dl className="cg-facts">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LeftOut({ note }: { note: string }) {
  return (
    <p className="cg-callout cg-leftout" role="note">
      <strong>Left out of this report.</strong> {note}
    </p>
  );
}

function Frame<T>({
  id,
  part,
  children,
}: {
  id: ReportSectionId;
  part: Part<T>;
  children: (data: T) => ReactNode;
}) {
  const index = REPORT_SECTIONS.findIndex((section) => section.id === id);
  const title = REPORT_SECTIONS[index]?.title ?? id;
  return (
    <section className="cg-sec" id={`r-${id}`} aria-labelledby={`r-${id}-h`}>
      <h2 id={`r-${id}-h`}>
        <span className="cg-num">{index + 1}.</span> {title}
      </h2>
      {part.state === 'left-out' ? (
        <LeftOut note={part.note} />
      ) : (
        <>
          {part.notes.map((note) => (
            <p key={note} className="cg-callout cg-callout--warn" role="note">
              <strong>Not included.</strong> {note}
            </p>
          ))}
          {children(part.data)}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------- the strip

const SHAPE_CLASS = {
  customer: 'cg-m--customer',
  engineer: 'cg-m--engineer',
  system: 'cg-m--system',
  decisions: 'cg-m--decisions',
} as const;

function Shape({
  shape,
  x,
  y,
  size,
  className,
}: {
  shape: StripShape;
  x: number;
  y: number;
  size: number;
  className: string;
}) {
  const cls = `cg-m ${className}`;
  if (shape === 'circle') return <circle className={cls} cx={x} cy={y} r={size} />;
  if (shape === 'square')
    return (
      <rect className={cls} x={x - size} y={y - size} width={size * 2} height={size * 2} rx={2} />
    );
  if (shape === 'triangle')
    return (
      <path
        className={cls}
        d={`M${x} ${y - size - 1}L${x + size + 1} ${y + size}L${x - size - 1} ${y + size}Z`}
      />
    );
  return (
    <path
      className={cls}
      d={`M${x} ${y - size}L${x + size} ${y}L${x} ${y + size}L${x - size} ${y}Z`}
    />
  );
}

function Marker({ marker }: { marker: StripMarker }) {
  return (
    <g>
      {marker.reasons.includes('resolution') ? (
        <circle className="cg-m__ring" cx={marker.x} cy={marker.y} r={12} />
      ) : null}
      <Shape
        shape={marker.shape}
        x={marker.x}
        y={marker.y}
        size={marker.kind === 'decision' ? 10 : 6}
        className={SHAPE_CLASS[marker.lane]}
      />
      {marker.number !== null ? (
        <text
          className="cg-m__num"
          x={marker.x}
          y={marker.y}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {marker.number}
        </text>
      ) : null}
    </g>
  );
}

/** The chronology as a picture, drawn with the same geometry as the review. It stands for the list under it. */
function Strip({ chronology, geometry }: { chronology: Chronology; geometry: StripGeometry }) {
  const { rows, plot, axis } = geometry;
  return (
    <div
      className="cg-strip-wrap"
      // The picture scrolls sideways on a narrow screen, so a keyboard must be able to reach it.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label="Chronology strip, scrollable"
    >
      <svg
        className="cg-strip"
        role="img"
        aria-label={`Chronology strip. ${chronology.summary}`}
        viewBox={`0 0 ${geometry.width} ${geometry.height}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        {rows.map((row, index) => (
          <g key={row.id}>
            <rect
              className={index % 2 === 0 ? 'cg-strip__row-alt' : 'cg-strip__row'}
              x={0}
              y={row.y}
              width={geometry.width}
              height={row.height}
            />
            <text
              className="cg-strip__label"
              x={12}
              y={row.y + row.height / 2}
              dominantBaseline="middle"
            >
              {row.label}
            </text>
            <line
              className="cg-strip__line"
              x1={plot.x1}
              x2={plot.x2}
              y1={row.y + row.height / 2}
              y2={row.y + row.height / 2}
            />
          </g>
        ))}
        {geometry.waits.map((wait) => (
          <g key={wait.id}>
            <rect
              className="cg-strip__wait"
              x={wait.x}
              y={plot.y1}
              width={wait.width}
              height={plot.y2 - plot.y1}
            />
            {wait.label ? (
              <text
                className="cg-strip__wait-label"
                x={wait.x + wait.width / 2}
                y={plot.y1 + 14}
                textAnchor="middle"
              >
                {wait.label}
              </text>
            ) : null}
          </g>
        ))}
        {geometry.ticks.map((tick) => (
          <line
            key={tick.id}
            className="cg-strip__tick"
            x1={tick.x}
            x2={tick.x}
            y1={tick.y1}
            y2={tick.y2}
          />
        ))}
        {geometry.markers.map((marker) => (
          <Marker key={marker.id} marker={marker} />
        ))}
        <line className="cg-strip__axis" x1={plot.x1} x2={plot.x2} y1={axis.y} y2={axis.y} />
        {axis.days.map((day) => (
          <g key={day.label}>
            <line className="cg-strip__axis" x1={day.x} x2={day.x} y1={axis.y} y2={axis.y + 6} />
            <text className="cg-strip__day" x={day.x} y={axis.y + 22} textAnchor="middle">
              {day.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Legend() {
  const swatch = (shape: StripShape, className: string): ReactNode => (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <Shape shape={shape} x={8} y={8} size={shape === 'diamond' ? 7 : 5} className={className} />
    </svg>
  );
  return (
    <ul className="cg-legend" aria-label="Legend">
      <li>{swatch('circle', SHAPE_CLASS.customer)} Customer</li>
      <li>{swatch('square', SHAPE_CLASS.engineer)} Engineer</li>
      <li>{swatch('triangle', SHAPE_CLASS.system)} System</li>
      <li>{swatch('diamond', SHAPE_CLASS.decisions)} Decision point (numbered)</li>
      <li>
        <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true">
          <rect className="cg-strip__wait" x="1" y="1" width="20" height="12" />
        </svg>{' '}
        Meaningful wait
      </li>
    </ul>
  );
}

function EventLine({ event }: { event: ChronologyEvent }) {
  const decisions = event.decisionNumbers.map((number) => `decision point ${number}`);
  return (
    <>
      <strong>{event.title}</strong>
      <span className="cg-meta">
        {' '}
        · {event.laneLabel} · {event.roleLabel}
        {decisions.length > 0 ? ` · ${decisions.join(', ')}` : ''}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------- the sections

function VerdictSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="verdict" part={report.verdict}>
      {({ verdict }) => (
        <>
          {verdict.placeholder ? (
            <p className="cg-callout cg-callout--warn">
              Nothing could be assessed: what was known is not enough to score any area, so there is
              no score to show.
            </p>
          ) : (
            <>
              <p className="cg-lead">
                {verdict.headline} {verdict.meaning}
              </p>
              <div
                className="cg-range"
                role="img"
                aria-label={`Case quality ${verdict.scoreText}, ${verdict.rangeText}, estimated`}
              >
                <span
                  className="cg-range__band"
                  style={{
                    left: `${verdict.low}%`,
                    width: `${Math.max(verdict.high - verdict.low, 1)}%`,
                  }}
                />
                <span className="cg-range__mark" style={{ left: `${verdict.score}%` }} />
                <span className="cg-range__scale" aria-hidden="true">
                  <span>0</span>
                  <span>100</span>
                </span>
              </div>
            </>
          )}
          <p className="cg-tags">
            <Tag tone="estimated">Estimated</Tag>
            <Tag>{verdict.bandLabel}</Tag>
          </p>
          <ul>
            {verdict.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
            {verdict.effort ? (
              <li>
                Avoidable support effort: <strong>{verdict.effort.display}</strong>
                {verdict.effort.rangeText ? `, plausible range ${verdict.effort.rangeText}` : ''} (
                {verdict.effort.confidenceLabel}). An estimate.
              </li>
            ) : null}
          </ul>
          {verdict.coachingSummary ? (
            <>
              <h3>In the coach’s words</h3>
              <p className="cg-quote">{verdict.coachingSummary}</p>
            </>
          ) : null}
        </>
      )}
    </Frame>
  );
}

function ChronologyBlock({ part }: { part: ChronologyPart }) {
  const { chronology, geometry } = part;
  const rows = chronologyRows(chronology);
  return (
    <>
      <p>{chronology.summary}</p>
      {part.truncated ? (
        <p className="cg-callout cg-callout--warn" role="note">
          <strong>Only part of the case is shown.</strong> The case has{' '}
          {plural(part.truncated.total, 'event')}; this covers the first{' '}
          {plural(part.truncated.read, 'event')}.
        </p>
      ) : null}
      {part.decisionsMarked ? null : (
        <p className="cg-callout cg-callout--warn" role="note">
          <strong>Decision points not marked.</strong> They could not be read.
        </p>
      )}
      <Strip chronology={chronology} geometry={geometry} />
      <Legend />
      <p className="cg-meta">
        Not to scale: the spacing is compressed so events close together stay readable beside a long
        wait. The list has the same events in words, with their exact times (UTC).
      </p>
      <h3>Key events and waits</h3>
      <ol
        className="cg-timeline"
        aria-label={`Key events and waits, ${plural(chronology.events.length, 'key event')}`}
      >
        {rows.map((row) =>
          row.kind === 'event' ? (
            <li key={`event-${row.event.id}`}>
              <span className="cg-when">{formatDateTimeUtc(row.event.at)}</span>
              <span>
                <EventLine event={row.event} />
              </span>
            </li>
          ) : (
            <li key={`wait-${row.wait.fromEventId}-${row.wait.toEventId}`}>
              <span className="cg-when">{formatDateTimeUtc(row.wait.fromAt)}</span>
              <span className="cg-wait">
                <strong>{row.wait.text}</strong> After “{row.wait.fromTitle}”, before “
                {row.wait.toTitle}”.
              </span>
            </li>
          ),
        )}
      </ol>
    </>
  );
}

function ChronologySection({ report }: { report: ReportModel }) {
  return (
    <Frame id="chronology" part={report.chronology}>
      {(part) => <ChronologyBlock part={part} />}
    </Frame>
  );
}

function MissedSection({
  report,
  caseId,
  origin,
}: {
  report: ReportModel;
  caseId: string;
  origin: string;
}) {
  return (
    <Frame id="missed" part={report.missed}>
      {({ moment }) =>
        moment ? (
          <>
            <h3>{moment.title}</h3>
            <p className="cg-meta">
              {formatDateTimeUtc(moment.at)} · {moment.categoryLabel}
            </p>
            <p>{moment.summary}</p>
            <Facts
              items={[
                { label: 'What was done', value: moment.didLabel },
                { label: 'What was already known', value: moment.knownSummary },
                ...(moment.betterLabel
                  ? [{ label: 'A better-supported step was available', value: moment.betterLabel }]
                  : []),
              ]}
            />
            {moment.knownLinks.length > 0 ? (
              <>
                <p className="cg-meta">Evidence on record at that moment:</p>
                <EvidenceList links={moment.knownLinks} label="Evidence on record at that moment" />
              </>
            ) : null}
            {origin ? (
              <p className="cg-meta">
                <a
                  href={`${origin}${caseHref(caseId, 'counterfactual')}?sel=${encodeURIComponent(moment.forkId)}`}
                >
                  Open this decision point in CaseGuard
                </a>
              </p>
            ) : null}
          </>
        ) : (
          <p>
            No decision point stood out: the analysis found no moment where a clearly
            better-supported step was available. That is a good sign for this case, not an error.
          </p>
        )
      }
    </Frame>
  );
}

function RecordedSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="recorded" part={report.recorded}>
      {(data) =>
        data.decision ? (
          <>
            <p>
              What the case recorded at the earliest important decision point, decision point{' '}
              {data.decision.number}: <strong>{data.decision.title}</strong> (
              {formatDateTimeUtc(data.decision.at)}).
            </p>
            <Facts
              items={[
                { label: 'What was done', value: data.decision.did },
                {
                  label: 'What it cost the customer',
                  value: [
                    data.decision.kind,
                    data.decision.effort,
                    data.decision.destructive ? 'Disruptive step' : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                },
                { label: 'What was already known', value: data.decision.known },
              ]}
            />
            {data.figures.length > 0 ? (
              <>
                <h3>Recorded figures</h3>
                <p className="cg-meta">
                  {data.figuresFrom === 'simulation'
                    ? 'The recorded side of the comparison in the next section.'
                    : 'Estimated by the analysis for this decision point; no better-supported path was simulated.'}
                </p>
                <Facts
                  items={data.figures.map((figure) => ({
                    label: figure.label,
                    value: figure.text,
                  }))}
                />
              </>
            ) : null}
          </>
        ) : (
          <p>No decision point stood out, so there is no single recorded step to compare.</p>
        )
      }
    </Frame>
  );
}

function PathBlock({ path }: { path: PathModel }) {
  return (
    <>
      <p className="cg-callout cg-callout--sim" role="note">
        <strong>Simulated estimate.</strong> Nothing here happened. It replays{' '}
        {path.decision ? `decision point ${path.decision.number}` : 'the decision'} with steps from
        the knowledge pack, using only what was known then.
      </p>
      {path.usable ? null : (
        <div className="cg-callout cg-callout--warn" role="note">
          <strong>This path is not reliable.</strong>
          <ul>
            {path.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <p>
        <strong>{path.strategyLabel}</strong>
        {path.decision
          ? ` at decision point ${path.decision.number}: ${path.decision.title}`
          : ''}. {path.headline}
      </p>
      <div className="cg-table-wrap">
        <table className="cg-table">
          <caption>The recorded path and the better-supported path (simulated estimate)</caption>
          <thead>
            <tr>
              <th scope="col">Measure</th>
              <th scope="col">Recorded</th>
              <th scope="col" className="cg-sim">
                Better-supported path (simulated estimate)
              </th>
              <th scope="col">Reading</th>
            </tr>
          </thead>
          <tbody>
            {path.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.recordedText}</td>
                <td className="cg-sim">{row.simulatedText}</td>
                <td>{row.directionLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="cg-tags">
        <Tag tone={path.confidence.level === 'high' ? 'good' : 'warn'}>
          {path.confidence.label} ({path.confidence.scoreText})
        </Tag>
        <Tag tone={path.validity.valid ? 'good' : 'bad'}>
          {path.validity.valid
            ? `All ${path.validity.total} validity checks passed`
            : `${path.validity.passed} of ${path.validity.total} validity checks passed`}
        </Tag>
        <Tag tone={path.validity.leakCheckPassed ? 'good' : 'bad'}>
          {path.validity.leakCheckPassed
            ? 'Used only what was known then'
            : 'Failed the “only what was known then” check'}
        </Tag>
        <Tag
          tone={path.review.accepted ? 'good' : path.review.state === 'rejected' ? 'bad' : 'warn'}
        >
          {path.review.label}
        </Tag>
      </p>
      <p>{path.confidence.rationale}</p>
      <h3>Assumptions</h3>
      <ul>
        {path.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
      <h3>The simulated steps</h3>
      <ol>
        {path.steps.map((step) => (
          <li key={step.index}>
            <strong>{step.label}</strong> — {step.ownerLabel}, {step.effortLabel.toLowerCase()}{' '}
            customer effort, done about {step.timing} after the decision. Expected result:{' '}
            {step.outcome}
            {step.supported ? '' : ' (not supported by the knowledge pack)'}
          </li>
        ))}
      </ol>
    </>
  );
}

function BetterSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="better" part={report.better}>
      {({ view }) =>
        view.kind === 'no-decision-points' ? (
          <p>
            Nothing to compare: no decision point stood out, so there was no better-supported path
            to simulate. That is a good sign for this case, not an error.
          </p>
        ) : view.kind === 'not-simulated' ? (
          <>
            <p className="cg-callout cg-callout--sim" role="note">
              <strong>No better-supported path has been simulated yet.</strong> Nobody has simulated
              what a better-supported path would have looked like at decision point{' '}
              {view.decision.number}: {view.decision.title}.
            </p>
            <p>
              An engineer or an administrator can run the simulation from the guided review. Until
              then this report has no better-supported path to show, and it does not guess one.
            </p>
          </>
        ) : (
          <PathBlock path={view.path} />
        )
      }
    </Frame>
  );
}

function RecommendationsSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="recommendations" part={report.recommendations}>
      {({ model }) => (
        <>
          {model.items.length === 0 ? (
            <p>
              The analysis has no recommendation for this case. That is a good sign, not an error.
            </p>
          ) : (
            <ol className="cg-list" aria-label="Ranked recommendations">
              {model.items.map((action, index) => (
                <li key={action.id} className="cg-item">
                  <p className="cg-meta">
                    <Tag tone={priorityTone(action.priorityBadge)}>{action.priorityLabel}</Tag>{' '}
                    {action.sourceLabel}
                    {action.alsoCoachesNext ? ' · also the coach’s next action' : ''}
                  </p>
                  <h3>
                    {index + 1}. {action.title}
                  </h3>
                  <p>{action.reason}</p>
                  {action.suggestion ? (
                    <p>
                      <strong>Suggested:</strong> {action.suggestion}
                    </p>
                  ) : null}
                  {action.owner || action.gain ? (
                    <p className="cg-meta">
                      {[
                        action.owner ? `Owner: ${action.owner}` : null,
                        action.gain ? `Expected gain (an estimate): ${action.gain}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  ) : null}
                  {action.hasEvidence ? (
                    <>
                      <p className="cg-meta">Evidence:</p>
                      <EvidenceList links={action.links} label={`Evidence for ${action.title}`} />
                    </>
                  ) : (
                    <p className="cg-general">{GENERAL_GUIDANCE}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="cg-meta">
            Warnings: {model.warnings.open} open, {model.warnings.resolved} resolved,{' '}
            {model.warnings.dismissed} dismissed.
            {model.noDiagnosticNote ? ` ${model.noDiagnosticNote}` : ''} Recommendations are about
            the case and the process, never about a person. Gains are estimates.
          </p>
        </>
      )}
    </Frame>
  );
}

function OverlayBlock({ view }: { view: OverlayView }) {
  return (
    <>
      {view.decision ? (
        <p>
          <strong>Where the skill would have mattered:</strong> {view.decision.title} (
          {formatDateTimeUtc(view.decision.at)}). {view.decision.summary}
        </p>
      ) : (
        <p>No decision point of this case is one where the skill would have changed course.</p>
      )}
      <p>
        <strong>What the case recorded:</strong>{' '}
        {view.recorded.label ? `${view.recorded.label}. ` : ''}
        {view.recorded.note}
      </p>
      {view.cheaper ? (
        <p>
          <strong>The skill’s cheaper alternative:</strong> {view.cheaper.use} instead of{' '}
          {view.cheaper.instead}. {view.cheaper.rationale}
          {view.cheaper.minutesSaved ? ` ${view.cheaper.minutesSaved}.` : ''}
        </p>
      ) : null}
      {view.savingOnly ? (
        <>
          {view.savingOnly.sharedBasis ? (
            <p>
              <small className="cg-muted">{view.savingOnly.sharedBasis}</small>
            </p>
          ) : null}
          <div className="cg-table-wrap">
            <table className="cg-table">
              <caption>
                What the skill saved on the case it came from (estimates; there is nothing on this
                case to set it against)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">The skill’s own saving (estimate)</th>
                </tr>
              </thead>
              <tbody>
                {view.savingOnly.rows.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.label}
                      {view.savingOnly?.sharedBasis ? null : (
                        <>
                          <br />
                          <small className="cg-muted">{row.basis}</small>
                        </>
                      )}
                    </th>
                    <td>{row.saved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="cg-table-wrap">
          <table className="cg-table">
            <caption>Recorded against with the skill (estimates worked out by the server)</caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Recorded</th>
                <th scope="col">With the skill (estimate)</th>
                <th scope="col">The skill’s own saving (estimate)</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">
                    {row.label}
                    <br />
                    <small className="cg-muted">{row.basis}</small>
                  </th>
                  <td>{row.recorded ?? 'Not available'}</td>
                  <td>{row.withSkill ?? 'Not available'}</td>
                  <td>{row.saved ?? 'Not available'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.assumptions.length > 0 ? (
        <>
          <h4>Assumptions</h4>
          <ul>
            {view.assumptions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {view.limitations.length > 0 ? (
        <>
          <h4>Limits of this comparison</h4>
          <ul>
            {view.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function LearningSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="learning" part={report.learning}>
      {(data) =>
        data.matches.length === 0 ? (
          <p>
            No reusable skill resembles this case
            {data.notApplicable > 0
              ? `; ${plural(data.notApplicable, 'skill')} matched but ${data.notApplicable === 1 ? 'does' : 'do'} not apply.`
              : '.'}{' '}
            Skills are extracted from a reviewer-accepted better path and then approved by a
            curator.
          </p>
        ) : (
          <>
            <ol className="cg-list" aria-label="Skills that resemble this case">
              {data.matches.map(({ match, overlay, overlayNote }) => (
                <li key={match.matchId} className="cg-item">
                  <p className="cg-meta">
                    <Tag tone={match.applicabilityBadge === 'productive' ? 'good' : 'warn'}>
                      {match.applicabilityLabel}
                    </Tag>{' '}
                    <Tag>{match.lifecycleLabel}</Tag> <Tag tone="estimated">Estimated match</Tag>
                  </p>
                  <h3>This resembles {match.skillName}</h3>
                  <p>
                    <strong>Match {match.scoreText}</strong> (model estimate), version{' '}
                    {match.version}. Matched using only the evidence on record up to{' '}
                    {formatDateTimeUtc(match.asOf)}.
                  </p>
                  <p>{match.rationale}</p>
                  {match.links.length > 0 ? (
                    <EvidenceList
                      links={match.links}
                      label={`Evidence that matched ${match.skillName}`}
                    />
                  ) : null}
                  {match.applied ? (
                    <p>
                      Plan adopted{match.appliedAt ? ` ${formatDateTimeUtc(match.appliedAt)}` : ''}
                      {match.appliedBy ? ` by ${match.appliedBy}` : ''}
                      {match.conformanceText ? `; ${match.conformanceText}` : ''}. Following a plan
                      describes the process, not the person.
                    </p>
                  ) : (
                    <p>The plan has not been adopted for this case.</p>
                  )}
                  {overlay ? (
                    <OverlayBlock view={overlay} />
                  ) : overlayNote ? (
                    <p className="cg-callout cg-callout--warn" role="note">
                      {overlayNote}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
            {data.more > 0 ? (
              <p className="cg-meta">
                {plural(data.more, 'more skill')} also resemble this case; they are in the skill
                library.
              </p>
            ) : null}
          </>
        )
      }
    </Frame>
  );
}

function MethodSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="method" part={report.method}>
      {(data) => (
        <>
          <h3>How certain is this?</h3>
          <ul>
            {data.uncertainty.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <h3>How this was calculated</h3>
          {data.notes.map((note) => (
            <div key={note.heading}>
              <h4>{note.heading}</h4>
              {note.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {note.facts.length > 0 ? (
                <Facts
                  items={note.facts.map((fact) => ({ label: fact.label, value: fact.value }))}
                />
              ) : null}
            </div>
          ))}
        </>
      )}
    </Frame>
  );
}

/** A list that may be unavailable (the reader may not read it, or the read failed): the note says so instead of a gap. */
function Listed<T>({
  part,
  children,
}: {
  part: { state: 'ready'; items: T[] } | { state: 'unavailable'; note: string };
  children: (items: T[]) => ReactNode;
}) {
  if (part.state === 'unavailable')
    return (
      <p className="cg-callout cg-callout--warn" role="note">
        <strong>Not included.</strong> {part.note}
      </p>
    );
  return <>{children(part.items)}</>;
}

const when = (at: string | null): string => (at ? formatDateTimeUtc(at) : 'time not recorded');

function ReviewBlock({ data }: { data: ReviewPart }) {
  const claims = data.claims;
  return (
    <>
      <p>{data.generated.sentence}</p>
      <h3>Claims a person reviewed</h3>
      {claims.state === 'unavailable' ? (
        <p className="cg-callout cg-callout--warn" role="note">
          <strong>Not included.</strong> {claims.note}
        </p>
      ) : claims.items.length === 0 ? (
        <p>No claim has been reviewed by a person yet.</p>
      ) : (
        <>
          <p>
            {plural(claims.items.length, 'claim')} reviewed: {claims.counts.confirmed} confirmed,{' '}
            {claims.counts.corrected} corrected, {claims.counts.rejected} rejected.
          </p>
          <ul>
            {claims.items.slice(0, REPORT_CLAIMS_SHOWN).map((claim) => (
              <li key={claim.id}>
                “{claim.text}” — {claim.state} by {claim.by ?? 'someone'}, {when(claim.at)}
                {claim.reason ? `: ${claim.reason}` : '.'}
              </li>
            ))}
          </ul>
          {claims.items.length > REPORT_CLAIMS_SHOWN ? (
            <p className="cg-meta">
              {plural(claims.items.length - REPORT_CLAIMS_SHOWN, 'more reviewed claim')} are in the
              evidence ledger.
            </p>
          ) : null}
        </>
      )}
      <h3>Reviews of the simulated paths</h3>
      <Listed part={data.paths}>
        {(items) =>
          items.length === 0 ? (
            <p>No simulated path has been reviewed by a person yet.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  {item.label}
                  {item.decision ? ` (${item.decision})` : ''} — {item.stateLabel}
                  {item.by ? ` by ${item.by}` : ''}, {when(item.at)}
                  {item.reason ? `: ${item.reason}` : '.'}
                </li>
              ))}
            </ul>
          )
        }
      </Listed>
      <h3>Warnings a person dismissed</h3>
      <Listed part={data.dismissedWarnings}>
        {(items) =>
          items.length === 0 ? (
            <p>No warning was dismissed.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  {item.title} — dismissed by {item.by}, {when(item.at)}: {item.reason}
                </li>
              ))}
            </ul>
          )
        }
      </Listed>
      <h3>Skill plans that were adopted</h3>
      <Listed part={data.skillApplications}>
        {(items) =>
          items.length === 0 ? (
            <p>No skill plan has been adopted for this case.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.matchId}>
                  {item.skillName} — adopted{item.appliedBy ? ` by ${item.appliedBy}` : ''},{' '}
                  {when(item.appliedAt)}
                  {item.conformance ? `; ${item.conformance}` : ''}.
                </li>
              ))}
            </ul>
          )
        }
      </Listed>
    </>
  );
}

function ReviewSection({ report }: { report: ReportModel }) {
  return (
    <Frame id="review" part={report.review}>
      {(data) => <ReviewBlock data={data} />}
    </Frame>
  );
}

/** The report: header, contents, the nine sections in order, and what was left out. */
export function ReportDocument({ report, caseId, origin, embedded = false }: ReportDocumentProps) {
  const header = report.header;
  return (
    <article className="cg-report" lang="en" aria-labelledby="r-title">
      <header className="cg-head">
        <p className="cg-eyebrow">CaseGuard AI · Guided review report</p>
        <h1 id="r-title" className={embedded ? 'cg-print-only' : undefined}>
          {header ? `${header.reference}: ${header.title}` : 'Guided review report'}
        </h1>
        <p className="cg-tags">
          <Tag tone="estimated">Estimated</Tag>
          <Tag tone="simulated">Simulated paths are labelled</Tag>
          {header?.synthetic ? <Tag>Synthetic data</Tag> : null}
        </p>
        {header ? (
          <Facts items={header.facts} />
        ) : (
          <p className="cg-callout cg-callout--warn" role="note">
            The case record could not be read, so its details are missing from this report.
          </p>
        )}
        <p className="cg-meta">
          Every score and range in this report is an estimate. A better-supported path is a
          simulation of what might have happened, not something that did.
          {origin ? (
            <>
              {' '}
              <a href={`${origin}${caseHref(caseId, 'review')}`}>
                Open the guided review in CaseGuard
              </a>
              .
            </>
          ) : null}
        </p>
      </header>
      {report.leftOut.length > 0 ? (
        <section className="cg-callout cg-leftout" aria-labelledby="r-left-out">
          <h2 id="r-left-out">Left out of this report</h2>
          <p>
            {plural(report.leftOut.length, 'section')} could not be included. Nothing was replaced
            by a guess.
          </p>
          <ul>
            {report.leftOut.map((item) => (
              <li key={item.id}>
                <strong>{item.title}.</strong> {item.note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <nav className="cg-contents" aria-label="Contents of the report">
        <h2>Contents</h2>
        <ol>
          {REPORT_SECTIONS.map((section) => (
            <li key={section.id}>
              <a className="cg-nourl" href={`#r-${section.id}`}>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <VerdictSection report={report} />
      <ChronologySection report={report} />
      <MissedSection report={report} caseId={caseId} origin={origin} />
      <RecordedSection report={report} />
      <BetterSection report={report} />
      <RecommendationsSection report={report} />
      <LearningSection report={report} />
      <MethodSection report={report} />
      <ReviewSection report={report} />
      <footer className="cg-foot">
        <p>
          Skills stay drafts until a curator approves them. This report is decision support for a
          human review, never a verdict about a person. To keep a PDF, use the print dialog of your
          browser and choose “Save as PDF”.
        </p>
      </footer>
    </article>
  );
}
