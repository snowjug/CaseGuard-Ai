'use client';

import { Button, makeStyles, tokens } from '@fluentui/react-components';
import type { GraphEdge, GraphNode } from '@caseguard/schemas';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { ScrollRegion } from '../a11y/ScrollRegion';
import { formatProbability } from '../format';
import { STATUS_META } from '../primitives/status-meta';
import { cg } from '../tokens/cg';
import { compareNodesForReading } from './layout';
import { KIND_META, edgeStyleOf } from './node-meta';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[3], color: cg.text },
  details: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
    padding: `${cg.space[2]} ${cg.space[3]}`,
  },
  summary: {
    cursor: 'pointer',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    minHeight: '28px',
    display: 'flex',
    alignItems: 'center',
  },
  paragraph: {
    margin: `${cg.space[2]} 0`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  scroll: { marginTop: cg.space[2] },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: tokens.fontSizeBase200 },
  caption: {
    textAlign: 'left',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
    padding: `${cg.space[2]} 0`,
  },
  th: {
    textAlign: 'left',
    padding: `${cg.space[1]} ${cg.space[2]}`,
    color: cg.textMuted,
    fontWeight: tokens.fontWeightSemibold,
    borderBottom: `1px solid ${cg.borderControl}`,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: `${cg.space[1]} ${cg.space[2]}`,
    borderBottom: `1px solid ${cg.borderSubtle}`,
    verticalAlign: 'top',
  },
  selectedRow: { backgroundColor: cg.tone.brand.tint },
  numeric: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
});

export interface GraphTextAlternativeProps {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  /** `InvestigationGraph.summary`: one paragraph describing the whole graph. */
  summary: string;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Expanded by default (used for the mobile list view). */
  defaultOpen?: boolean;
  /** Render as a plain section instead of a collapsed `<details>` (mobile fallback). */
  asList?: boolean;
  id?: string;
}

/**
 * Accessible text alternative to the canvas: the summary paragraph, a table of every node in reading order and a
 * table of every edge. Rows can be selected with a real button, so the whole graph is operable without the canvas.
 */
export function GraphTextAlternative({
  nodes,
  edges,
  summary,
  selectedId = null,
  onSelect,
  defaultOpen = false,
  asList = false,
  id,
}: GraphTextAlternativeProps) {
  const styles = useStyles();
  const ordered = [...nodes].sort(compareNodesForReading);
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
  const body = (
    <>
      <p className={styles.paragraph}>{summary}</p>
      <ScrollRegion label="Nodes table, scrollable" className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.caption}>Nodes in reading order ({ordered.length})</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                #
              </th>
              <th scope="col" className={styles.th}>
                Type
              </th>
              <th scope="col" className={styles.th}>
                Label
              </th>
              <th scope="col" className={styles.th}>
                Status
              </th>
              <th scope="col" className={styles.th}>
                Simulated
              </th>
              <th scope="col" className={styles.th}>
                Confidence
              </th>
              {onSelect ? (
                <th scope="col" className={styles.th}>
                  <VisuallyHidden>Select</VisuallyHidden>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {ordered.map((node, index) => (
              <tr key={node.id} className={node.id === selectedId ? styles.selectedRow : undefined}>
                <td className={`${styles.td} ${styles.numeric}`}>{index + 1}</td>
                <td className={styles.td}>{KIND_META[node.kind].label}</td>
                <th
                  scope="row"
                  className={styles.td}
                  style={{ textAlign: 'left', fontWeight: 400 }}
                >
                  {node.label}
                </th>
                <td className={styles.td}>{STATUS_META[node.status].label}</td>
                <td className={styles.td}>{node.simulated ? 'Simulated' : 'No'}</td>
                <td className={`${styles.td} ${styles.numeric}`}>
                  {node.confidence === null
                    ? '—'
                    : `${formatProbability(node.confidence)} (estimate)`}
                </td>
                {onSelect ? (
                  <td className={styles.td}>
                    <Button
                      size="small"
                      appearance={node.id === selectedId ? 'primary' : 'outline'}
                      aria-pressed={node.id === selectedId}
                      aria-label={`${node.id === selectedId ? 'Selected' : 'Select'}: ${node.label}`}
                      onClick={() => onSelect(node.id === selectedId ? null : node.id)}
                    >
                      {node.id === selectedId ? 'Selected' : 'Select'}
                    </Button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <ScrollRegion label="Edges table, scrollable" className={styles.scroll}>
        <table className={styles.table}>
          <caption className={styles.caption}>Connections ({edges.length})</caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                From
              </th>
              <th scope="col" className={styles.th}>
                Relationship
              </th>
              <th scope="col" className={styles.th}>
                To
              </th>
              <th scope="col" className={styles.th}>
                Simulated
              </th>
            </tr>
          </thead>
          <tbody>
            {edges.map((edge) => (
              <tr key={edge.id}>
                <td className={styles.td}>{labelOf.get(edge.from) ?? edge.from}</td>
                <td className={styles.td}>
                  {edgeStyleOf(edge).label}
                  {edge.label ? ` (${edge.label})` : ''}
                </td>
                <td className={styles.td}>{labelOf.get(edge.to) ?? edge.to}</td>
                <td className={styles.td}>{edge.simulated ? 'Simulated' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </>
  );

  if (asList) {
    return (
      <section id={id} className={styles.root} aria-label="Investigation graph as a list">
        {body}
      </section>
    );
  }
  return (
    <details id={id} className={styles.details} open={defaultOpen || undefined}>
      <summary className={styles.summary}>
        Text alternative: the graph as a summary, a node table and a connection table
      </summary>
      {body}
    </details>
  );
}
