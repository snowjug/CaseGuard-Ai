'use client';

import { makeStyles, tokens } from '@fluentui/react-components';
import { cg } from '../tokens/cg';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { SvgPatternDefs, patternUrl } from '../primitives/SvgPatternDefs';
import { StatusBadge } from '../primitives/StatusBadge';
import { shapePath } from './geometry';
import { GRAPH_NODE_KINDS, KIND_META, type GraphNodeKind } from './node-meta';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[2]} ${cg.space[6]}`,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  group: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[3]}`,
  },
  title: {
    margin: 0,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  list: { display: 'contents', margin: 0, padding: 0, listStyle: 'none' },
  item: { display: 'inline-flex', alignItems: 'center', gap: cg.space[1], whiteSpace: 'nowrap' },
});

export interface GraphLegendProps {
  /** Node kinds to list (default: all eight). */
  kinds?: readonly GraphNodeKind[];
  /** Prefix for the pattern ids defined by the legend's own `<defs>`. */
  idPrefix?: string;
}

/** Legend for the investigation graph: node shapes, status badges and connection styles. */
export function GraphLegend({
  kinds = GRAPH_NODE_KINDS,
  idPrefix = 'cg-legend',
}: GraphLegendProps) {
  const styles = useStyles();
  return (
    <div className={styles.root} role="group" aria-label="Graph legend">
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        focusable="false"
        style={{ position: 'absolute' }}
      >
        <SvgPatternDefs idPrefix={idPrefix} tones={['simulated']} kinds={['hatch']} />
      </svg>
      <div className={styles.group}>
        <p className={styles.title}>Nodes</p>
        <ul className={styles.list} aria-label="Node shapes">
          {kinds.map((kind) => {
            const meta = KIND_META[kind];
            const tone = cg.tone[meta.tone];
            const fill =
              meta.fill === 'solid'
                ? tone.solid
                : meta.fill === 'hatch'
                  ? patternUrl(idPrefix, 'hatch', 'simulated')
                  : tone.tint;
            return (
              <li key={kind} className={styles.item}>
                <svg
                  width="30"
                  height="26"
                  viewBox="0 0 30 26"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d={shapePath(meta.shape, 15, 13, 0.5)}
                    fill={fill}
                    stroke={tone.solid}
                    strokeWidth={1.5}
                    strokeDasharray={meta.fill === 'hatch' ? '3 2' : undefined}
                  />
                </svg>
                {meta.label}
              </li>
            );
          })}
        </ul>
      </div>
      <div className={styles.group}>
        <p className={styles.title}>Status</p>
        <ul className={styles.list} aria-label="Status badges">
          {(['productive', 'uncertain', 'unsupported', 'missing'] as const).map((status) => (
            <li key={status} className={styles.item}>
              <StatusBadge status={status} size="small" />
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.group}>
        <p className={styles.title}>Connections</p>
        <ul className={styles.list} aria-label="Connection styles">
          <li className={styles.item}>
            <svg width="40" height="14" viewBox="0 0 40 14" aria-hidden="true" focusable="false">
              <path d="M2 7H31" stroke={cg.tone.actual.solid} strokeWidth={2.75} />
              <path d="M30 2L38 7L30 12Z" fill={cg.tone.actual.solid} />
            </svg>
            Actual path (solid)
          </li>
          <li className={styles.item}>
            <svg width="40" height="14" viewBox="0 0 40 14" aria-hidden="true" focusable="false">
              <path
                d="M2 7H31"
                stroke={patternUrl(idPrefix, 'hatch', 'simulated')}
                strokeWidth={7}
                strokeDasharray="8 5"
              />
              <path
                d="M2 7H31"
                stroke={cg.tone.simulated.solid}
                strokeWidth={2}
                strokeDasharray="8 5"
              />
              <path d="M30 2L38 7L30 12Z" fill={cg.tone.simulated.solid} />
            </svg>
            Simulated path (dashed, hatched)
          </li>
          <li className={styles.item}>
            <svg width="40" height="14" viewBox="0 0 40 14" aria-hidden="true" focusable="false">
              <path d="M2 7H31" stroke={cg.tone.evidence.solid} strokeWidth={1.5} />
              <path d="M30 3L37 7L30 11Z" fill={cg.tone.evidence.solid} />
            </svg>
            Supports
          </li>
          <li className={styles.item}>
            <svg width="40" height="14" viewBox="0 0 40 14" aria-hidden="true" focusable="false">
              <path d="M2 7H33" stroke={cg.tone.unsupported.solid} strokeWidth={1.75} />
              <path d="M34 2V12" stroke={cg.tone.unsupported.solid} strokeWidth={2.5} />
            </svg>
            Contradicts
          </li>
        </ul>
      </div>
      <VisuallyHidden>
        Simulated items are always labelled Simulated: they show what could have happened, not what
        did.
      </VisuallyHidden>
    </div>
  );
}
