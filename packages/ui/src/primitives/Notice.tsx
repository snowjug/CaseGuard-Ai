'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CalculatorIcon, InfoIcon, TriangleAlertIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { VisuallyHidden } from '../a11y/VisuallyHidden';
import { cg } from '../tokens/cg';
import type { ToneName } from '../tokens/palette';

export type NoticeVariant = 'info' | 'warning' | 'synthetic' | 'model-estimate';

const VARIANTS: Record<NoticeVariant, { tone: ToneName; icon: LucideIcon; title: string }> = {
  info: { tone: 'neutral', icon: InfoIcon, title: 'Information' },
  warning: { tone: 'uncertain', icon: TriangleAlertIcon, title: 'Warning' },
  synthetic: { tone: 'neutral', icon: InfoIcon, title: 'Demo data' },
  'model-estimate': { tone: 'brand', icon: CalculatorIcon, title: 'Model estimate' },
};

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[3],
    padding: `${cg.space[3]} ${cg.space[4]}`,
    borderRadius: cg.radius.md,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.text,
  },
  compact: {
    padding: `${cg.space[2]} ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  icon: { flexShrink: 0, marginTop: '2px', fontSize: '18px', display: 'inline-flex' },
  body: { minWidth: 0, flex: 1 },
  title: { fontWeight: tokens.fontWeightSemibold, marginRight: cg.space[2] },
  action: { flexShrink: 0, alignSelf: 'center' },
});

export interface NoticeProps {
  /**
   * `info` and `warning` are general callouts. `synthetic` marks demo data and `model-estimate` marks values that
   * are estimates. Use at most one notice per screen, and only when it changes what the person should do.
   */
  variant?: NoticeVariant;
  /** Bold lead-in. Defaults to a variant-specific title; pass `null` to omit. */
  title?: string | null;
  children: ReactNode;
  /** Optional trailing control (a button or link). */
  action?: ReactNode;
  /** Smaller padding and type for use inside cards. */
  compact?: boolean;
  className?: string;
}

/**
 * Callout for guidance messages. It is a static `note` (not an alert), always carries an icon and a text title in
 * addition to colour.
 */
export function Notice({
  variant = 'info',
  title,
  children,
  action,
  compact = false,
  className,
}: NoticeProps) {
  const styles = useStyles();
  const meta = VARIANTS[variant];
  const t = cg.tone[meta.tone];
  const Icon = meta.icon;
  const heading = title === undefined ? meta.title : title;
  return (
    <div
      role="note"
      data-variant={variant}
      className={mergeClasses(styles.root, compact && styles.compact, className)}
      style={{
        backgroundColor: t.tint,
        border: `1px solid color-mix(in srgb, ${t.border} 35%, transparent)`,
      }}
    >
      <span aria-hidden="true" className={styles.icon} style={{ color: t.fg }}>
        <Icon />
      </span>
      <div className={styles.body}>
        {heading ? (
          <span className={styles.title} style={{ color: t.fg }}>
            {heading}
            <VisuallyHidden>: </VisuallyHidden>
          </span>
        ) : null}
        {children}
      </div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
