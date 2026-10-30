'use client';

import type { ReactNode } from 'react';
import { useSystemStyles } from './styles';

export interface StatItem {
  id: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/** A row of labelled figures (a description list, so the label is the term of the value). */
export function Stats({ items, label }: { items: readonly StatItem[]; label: string }) {
  const styles = useSystemStyles();
  return (
    <dl className={styles.stats} aria-label={label}>
      {items.map((item) => (
        <div key={item.id} className={styles.stat}>
          <dt className={styles.statLabel}>{item.label}</dt>
          <dd className={styles.statValue} style={{ margin: 0 }}>
            {item.value}
            {item.hint ? <span className={styles.statHint}>{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
