'use client';

import { Select, makeStyles } from '@fluentui/react-components';
import { shortId } from '../../lib/format';
import { useCaseOptions } from './use-case-options';

const useStyles = makeStyles({
  // A native select is as wide as its longest option, which would push a narrow screen sideways.
  root: { width: '100%', minWidth: 0, maxWidth: '100%' },
  native: { width: '100%', minWidth: 0 },
});

export interface CaseFilterSelectProps {
  /** The chosen case id, or an empty string for "any". */
  value: string;
  /** Label of the empty choice, for example "All cases". */
  emptyLabel: string;
  /** Put the case title after its reference (the audit filter only has room for the reference). */
  showTitle?: boolean;
  onChange: (caseId: string) => void;
}

/** A case picker for the Governance filters: the cases the header switcher already loaded, as a native select. */
export function CaseFilterSelect({
  value,
  emptyLabel,
  showTitle = true,
  onChange,
}: CaseFilterSelectProps) {
  const styles = useStyles();
  const cases = useCaseOptions();
  return (
    <Select
      className={styles.root}
      select={{ className: styles.native }}
      value={value}
      onChange={(_event, data) => onChange(data.value)}
    >
      <option value="">{emptyLabel}</option>
      {cases.map((item) => (
        <option key={item.id} value={item.id}>
          {showTitle ? `${item.reference} · ${item.title}` : item.reference}
        </option>
      ))}
      {value && !cases.some((item) => item.id === value) ? (
        <option value={value}>{shortId(value, 18)}</option>
      ) : null}
    </Select>
  );
}
