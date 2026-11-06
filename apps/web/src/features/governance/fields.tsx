'use client';

import { AccordionItem, Field, Input, Select, cg } from '@caseguard/ui';
import { Switch, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { StateBadge } from '../../lib/advanced-view-parts';
import { getIn } from './messages';

/** What every field of one section editor shares: the draft, how to change it, the problems and whether it is read-only. */
export interface EditorState {
  draft: unknown;
  set: (path: string, value: unknown) => void;
  /** Problems by dotted path, from client validation and from the API's 422. */
  errors: Readonly<Record<string, string>>;
  /** True while saving or when the role may not change the section. */
  disabled: boolean;
}

const EditorContext = createContext<EditorState | null>(null);

export const EditorProvider = EditorContext.Provider;

export function useEditor(): EditorState {
  const value = useContext(EditorContext);
  if (!value) throw new Error('A governance field must be rendered inside a section editor');
  return value;
}

const wide = '@media (min-width: 720px)';

const useStyles = makeStyles({
  rows: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  groupText: {
    margin: `0 0 ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  groupError: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    color: cg.tone.unsupported.fg,
    fontWeight: tokens.fontWeightSemibold,
  },
  // One setting is one row: what it is on the left (label, hint, problem), the control on the right; stacked on a phone.
  // The kit `Field` is the row: the selectors place its label, control and messages without wrapping them again.
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    padding: `${cg.space[3]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0 },
    [wide]: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)',
      columnGap: cg.space[6],
      rowGap: 0,
      alignItems: 'start',
    },
    '& > label': {
      gridColumn: '1',
      gridRow: '1',
      fontSize: tokens.fontSizeBase300,
      fontWeight: tokens.fontWeightMedium,
      color: cg.text,
    },
    '& > span': { gridColumn: '2', gridRow: '1 / span 4' },
    '& > p': { gridColumn: '1', marginTop: cg.space[1] },
  },
  narrow: { maxWidth: '240px' },
  cell: { maxWidth: '148px' },
  unit: { color: cg.textMuted, fontSize: tokens.fontSizeBase200 },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: cg.space[4],
    minHeight: '44px',
    padding: `${cg.space[3]} 0`,
    borderTop: `1px solid ${cg.borderSubtle}`,
    ':first-child': { borderTop: 0 },
    [wide]: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)',
      columnGap: cg.space[6],
      justifyContent: 'stretch',
    },
  },
  switchText: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  switchLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightMedium,
    color: cg.text,
  },
  hint: {
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  hintError: { color: cg.tone.unsupported.fg },
});

/** The settings of one group, one per row. */
export function FieldRows({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <div className={styles.rows}>{children}</div>;
}

export interface FieldGroupProps {
  title: string;
  description?: ReactNode;
  /**
   * Dotted paths of the settings in the group. A problem under any of them opens the group and says so in its header,
   * so a closed group can never hide the reason that saving is blocked.
   */
  paths?: readonly string[];
  /** The group is open when the section first shows (the first group of a section). */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A labelled group of related settings, collapsed unless it is the first or has a problem. Its content stays mounted
 * while closed (and is inert), so a draft and its validation never depend on what is open.
 */
export function FieldGroup({
  title,
  description,
  paths = [],
  defaultOpen = false,
  children,
}: FieldGroupProps) {
  const styles = useStyles();
  const { errors } = useEditor();
  const [open, setOpen] = useState(defaultOpen);
  const problems = Object.keys(errors).filter((key) =>
    paths.some((path) => key === path || key.startsWith(`${path}.`)),
  ).length;
  return (
    <AccordionItem
      headingLevel={3}
      title={title}
      lazy={false}
      open={open || problems > 0}
      onOpenChange={setOpen}
      badge={
        problems > 0 ? (
          <StateBadge
            status="unsupported"
            size="sm"
            label={`${problems} ${problems === 1 ? 'problem' : 'problems'}`}
          />
        ) : undefined
      }
    >
      {description ? <p className={styles.groupText}>{description}</p> : null}
      <FieldRows>{children}</FieldRows>
    </AccordionItem>
  );
}

/** A problem that belongs to a whole group (bands that must descend) rather than one field. */
export function GroupError({ path }: { path: string }) {
  const styles = useStyles();
  const { errors } = useEditor();
  const error = errors[path];
  return error ? (
    <p role="alert" className={styles.groupError}>
      {error}
    </p>
  ) : null;
}

interface BaseFieldProps {
  /** Dotted path of the setting inside the section value. */
  path: string;
  label: string;
  hint?: string;
  /** Label above the control instead of beside it: for a field that sits in a row of fields. */
  stacked?: boolean;
}

export interface NumberFieldProps extends BaseFieldProps {
  /** An empty box means "not set" (null) instead of an error. */
  nullable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number, for example "ms". */
  unit?: string;
  /** What an empty box means ("No limit set"): a hint beside the label, never the label itself. */
  placeholder?: string;
  /** For dense tables: the label becomes the accessible name instead of visible text. */
  hideLabel?: boolean;
}

/**
 * A number setting. The box keeps what the person typed (so "0." can be typed); a value that is not a number is passed
 * on as NaN, which validation reports as "Enter a number" instead of being silently replaced.
 */
export function NumberField({
  path,
  label,
  hint,
  nullable = false,
  min,
  max,
  step,
  unit,
  placeholder,
  hideLabel = false,
  stacked = false,
}: NumberFieldProps) {
  const styles = useStyles();
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  const [text, setText] = useState(() =>
    typeof current === 'number' && Number.isFinite(current) ? String(current) : '',
  );
  return (
    <Field
      label={hideLabel ? <span className="cg-sr-only">{label}</span> : label}
      hint={hint}
      error={errors[path]}
      className={hideLabel || stacked ? undefined : styles.row}
    >
      <Input
        type="number"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        wrapperClassName={hideLabel ? styles.cell : styles.narrow}
        {...(placeholder ? { placeholder } : {})}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        {...(unit ? { endAdornment: <span className={styles.unit}>{unit}</span> } : {})}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          if (value.trim() === '') {
            set(path, nullable ? null : Number.NaN);
            return;
          }
          const parsed = Number(value);
          set(path, Number.isFinite(parsed) ? parsed : Number.NaN);
        }}
      />
    </Field>
  );
}

export interface TextFieldProps extends BaseFieldProps {
  /** An empty box means "not set" (null). */
  nullable?: boolean;
  maxLength?: number;
  placeholder?: string;
  /** Without a visible label (a table cell or a repeated row): the label is the accessible name. */
  hideLabel?: boolean;
}

/** A text setting. */
export function TextField({
  path,
  label,
  hint,
  nullable = false,
  maxLength,
  placeholder,
  hideLabel = false,
  stacked = false,
}: TextFieldProps) {
  const styles = useStyles();
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  return (
    <Field
      label={hideLabel ? <span className="cg-sr-only">{label}</span> : label}
      hint={hint}
      error={errors[path]}
      className={hideLabel || stacked ? undefined : styles.row}
    >
      <Input
        value={typeof current === 'string' ? current : ''}
        disabled={disabled}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(placeholder ? { placeholder } : {})}
        onChange={(event) =>
          set(path, nullable && event.target.value === '' ? null : event.target.value)
        }
      />
    </Field>
  );
}

export interface SwitchFieldProps extends BaseFieldProps {
  /** When set, the switch cannot be changed and this says why. */
  lockedReason?: string;
}

export interface SwitchRowProps {
  label: string;
  hint?: string | undefined;
  /** A problem with the setting: shown in place of the hint, as an alert. */
  error?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
}

/** One on/off setting as a row: the label (which toggles it) and its hint on the left, the switch on the right. */
export function SwitchRow({ label, hint, error, checked, disabled, onChange }: SwitchRowProps) {
  const styles = useStyles();
  const id = useId();
  const hintId = `${id}-hint`;
  const note = error ?? hint;
  return (
    <div className={styles.switchRow}>
      <div className={styles.switchText}>
        <label htmlFor={id} className={styles.switchLabel}>
          {label}
        </label>
        {note ? (
          <span
            id={hintId}
            className={mergeClasses(styles.hint, error && styles.hintError)}
            role={error ? 'alert' : undefined}
          >
            {note}
          </span>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled ?? false}
        {...(note ? { 'aria-describedby': hintId } : {})}
        onChange={(_event, data) => onChange?.(data.checked)}
      />
    </div>
  );
}

/** An on/off setting of the section being edited. */
export function SwitchField({ path, label, hint, lockedReason }: SwitchFieldProps) {
  const { draft, set, errors, disabled } = useEditor();
  return (
    <SwitchRow
      label={label}
      hint={lockedReason ?? hint}
      error={lockedReason ? undefined : errors[path]}
      checked={getIn(draft, path) === true}
      disabled={disabled || lockedReason !== undefined}
      onChange={(on) => set(path, on)}
    />
  );
}

export interface SelectFieldProps extends BaseFieldProps {
  options: readonly { value: string; label: string }[];
  hideLabel?: boolean;
}

/** A choice among a fixed set. */
export function SelectField({
  path,
  label,
  hint,
  options,
  hideLabel = false,
  stacked = false,
}: SelectFieldProps) {
  const styles = useStyles();
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  return (
    <Field
      label={hideLabel ? <span className="cg-sr-only">{label}</span> : label}
      hint={hint}
      error={errors[path]}
      className={hideLabel || stacked ? undefined : styles.row}
    >
      <Select
        value={typeof current === 'string' ? current : ''}
        disabled={disabled}
        onChange={(event) => set(path, event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
