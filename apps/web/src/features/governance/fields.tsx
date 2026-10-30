'use client';

import { cg } from '@caseguard/ui';
import { Field, Input, Select, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
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

const useStyles = makeStyles({
  group: {
    margin: 0,
    padding: cg.space[3],
    border: `1px solid ${cg.borderSubtle}`,
    borderRadius: cg.radius.md,
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
  },
  legend: {
    padding: `0 ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  groupText: {
    margin: 0,
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
  grid: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
  },
  grid2: { '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' } },
  grid3: {
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (min-width: 1280px)': { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
  },
  switchRow: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  hint: { fontSize: tokens.fontSizeBase200, color: cg.textMuted, paddingLeft: '44px' },
});

/** A labelled group of related settings (a native `fieldset`, so assistive technology announces the group). */
export function FieldGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const styles = useStyles();
  return (
    <fieldset className={styles.group}>
      <legend className={styles.legend}>{title}</legend>
      {description ? <p className={styles.groupText}>{description}</p> : null}
      {children}
    </fieldset>
  );
}

/** Responsive grid for fields (one column on a phone, two on a tablet, up to three on a wide screen). */
export function FieldGrid({ children, columns = 3 }: { children: ReactNode; columns?: 2 | 3 }) {
  const styles = useStyles();
  return (
    <div className={`${styles.grid} ${columns === 2 ? styles.grid2 : styles.grid3}`}>
      {children}
    </div>
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
}

export interface NumberFieldProps extends BaseFieldProps {
  /** An empty box means "not set" (null) instead of an error. */
  nullable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Shown after the number, for example "ms". */
  unit?: string;
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
}: NumberFieldProps) {
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  const [text, setText] = useState(() =>
    typeof current === 'number' && Number.isFinite(current) ? String(current) : '',
  );
  const error = errors[path];
  return (
    <Field
      {...(hideLabel ? {} : { label })}
      hint={hint}
      validationState={error ? 'error' : 'none'}
      validationMessage={error}
    >
      <Input
        type="number"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        {...(hideLabel ? { 'aria-label': label } : {})}
        {...(placeholder ? { placeholder } : {})}
        {...(min !== undefined ? { min } : {})}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        {...(unit ? { contentAfter: <span>{unit}</span> } : {})}
        onChange={(_event, data) => {
          setText(data.value);
          if (data.value.trim() === '') {
            set(path, nullable ? null : Number.NaN);
            return;
          }
          const parsed = Number(data.value);
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
}

/** A text setting. */
export function TextField({
  path,
  label,
  hint,
  nullable = false,
  maxLength,
  placeholder,
}: TextFieldProps) {
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  const error = errors[path];
  return (
    <Field
      label={label}
      hint={hint}
      validationState={error ? 'error' : 'none'}
      validationMessage={error}
    >
      <Input
        value={typeof current === 'string' ? current : ''}
        disabled={disabled}
        {...(maxLength !== undefined ? { maxLength } : {})}
        {...(placeholder ? { placeholder } : {})}
        onChange={(_event, data) => set(path, nullable && data.value === '' ? null : data.value)}
      />
    </Field>
  );
}

export interface SwitchFieldProps extends BaseFieldProps {
  /** When set, the switch cannot be changed and this says why. */
  lockedReason?: string;
}

/** An on/off setting. */
export function SwitchField({ path, label, hint, lockedReason }: SwitchFieldProps) {
  const styles = useStyles();
  const { draft, set, errors, disabled } = useEditor();
  const hintId = useId();
  const error = errors[path];
  const note = lockedReason ?? error ?? hint;
  return (
    <div className={styles.switchRow}>
      <Switch
        label={label}
        checked={getIn(draft, path) === true}
        disabled={disabled || lockedReason !== undefined}
        {...(note ? { 'aria-describedby': hintId } : {})}
        onChange={(_event, data) => set(path, data.checked)}
      />
      {note ? (
        <span id={hintId} className={styles.hint} role={error ? 'alert' : undefined}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface SelectFieldProps extends BaseFieldProps {
  options: readonly { value: string; label: string }[];
}

/** A choice among a fixed set. */
export function SelectField({ path, label, hint, options }: SelectFieldProps) {
  const { draft, set, errors, disabled } = useEditor();
  const current = getIn(draft, path);
  const error = errors[path];
  return (
    <Field
      label={label}
      hint={hint}
      validationState={error ? 'error' : 'none'}
      validationMessage={error}
    >
      <Select
        value={typeof current === 'string' ? current : ''}
        disabled={disabled}
        onChange={(_event, data) => set(path, data.value)}
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
