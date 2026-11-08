'use client';

import { Select, type SelectProps } from '@caseguard/ui';
import { shortId } from '../../lib/format';
import { useCaseOptions } from './use-case-options';

export interface CaseFilterSelectProps extends Omit<
  SelectProps,
  'value' | 'onChange' | 'children' | 'wrapperClassName'
> {
  /** The chosen case id, or an empty string for "any". */
  value: string;
  /** Label of the empty choice, for example "All cases". */
  emptyLabel: string;
  /** Put the case title after its reference (the audit filter only has room for the reference). */
  showTitle?: boolean;
  onChange: (caseId: string) => void;
}

/**
 * A case picker for the filters of Settings and audit: the cases the case list already loaded, as a native select. It
 * takes the `id` and `aria-*` props of a `Field`, so the label of the field names it.
 */
export function CaseFilterSelect({
  value,
  emptyLabel,
  showTitle = true,
  onChange,
  ...select
}: CaseFilterSelectProps) {
  const cases = useCaseOptions();
  return (
    <Select {...select} value={value} onChange={(event) => onChange(event.target.value)}>
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
