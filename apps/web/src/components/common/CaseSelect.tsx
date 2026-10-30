'use client';

import type { CaseSummary } from '@caseguard/schemas';
import { Select, makeStyles } from '@fluentui/react-components';
import { useId } from 'react';
import { describeError } from '../../lib/api/errors';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { cg } from '@caseguard/ui';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  label: { fontSize: '12px', color: cg.textMuted, fontWeight: 600 },
  select: { minWidth: '200px', maxWidth: '320px' },
});

export interface CaseSelectProps {
  /** Selected case id, or null/undefined for none. */
  value: string | null | undefined;
  onChange: (caseId: string) => void;
  /** Visible label above the control. Omit and pass `ariaLabel` for compact use (the header). */
  label?: string;
  ariaLabel?: string;
  className?: string;
}

/** Case chooser bound to `cases.list`. Used by the header switcher and the Command Center. */
export function CaseSelect({
  value,
  onChange,
  label,
  ariaLabel = 'Active case',
  className,
}: CaseSelectProps) {
  const styles = useStyles();
  const id = useId();
  const auth = useAuth();
  const cases = useApiQuery(
    'cases.list',
    { query: { limit: 100 } },
    { enabled: auth.status === 'ready', staleTime: 30_000 },
  );
  const items: readonly CaseSummary[] = cases.data?.items ?? [];
  const status =
    cases.isPending && auth.status === 'ready'
      ? 'Loading cases…'
      : cases.isError
        ? 'Cases unavailable'
        : items.length === 0
          ? 'No cases yet'
          : null;
  const known = items.some((c) => c.id === value);
  // The full reason is available on hover; the control itself stays short enough to fit the header.
  const detail = cases.isError
    ? `Cases unavailable: ${describeError(cases.error)}`
    : (status ?? undefined);

  return (
    <div className={className ?? styles.root}>
      {label ? (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      ) : null}
      <Select
        id={id}
        className={styles.select}
        aria-label={label ? undefined : ariaLabel}
        disabled={items.length === 0}
        value={known && value ? value : ''}
        onChange={(_event, data) => {
          if (data.value) onChange(data.value);
        }}
        title={detail}
      >
        <option value="" disabled>
          {status ?? 'Choose a case'}
        </option>
        {items.map((c) => (
          <option key={c.id} value={c.id}>
            {c.reference} · {c.title}
          </option>
        ))}
      </Select>
    </div>
  );
}
