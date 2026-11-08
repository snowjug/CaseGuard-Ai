'use client';

import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDownIcon, CircleAlertIcon } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cg } from '../tokens/cg';
import { borderColors } from './styles';

const useStyles = makeStyles({
  field: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  label: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  required: { color: cg.tone.unsupported.fg },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: cg.space[1],
    margin: 0,
    fontSize: tokens.fontSizeBase200,
    color: cg.tone.unsupported.fg,
  },
  control: {
    display: 'flex',
    alignItems: 'center',
    gap: cg.space[2],
    boxSizing: 'border-box',
    minHeight: '40px',
    paddingInline: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderControl}`,
    backgroundColor: cg.surfaceSunken,
    color: cg.text,
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: cg.motion.fast,
    transitionTimingFunction: cg.motion.easing,
    '@media (pointer: coarse)': { minHeight: '46px' },
    ':focus-within': { ...borderColors(cg.focus), boxShadow: `0 0 0 3px ${cg.glow}` },
  },
  invalid: borderColors(cg.tone.unsupported.border),
  disabled: { opacity: 0.55, cursor: 'not-allowed' },
  native: {
    flex: '1 1 auto',
    alignSelf: 'stretch',
    minWidth: 0,
    padding: 0,
    border: 0,
    outline: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    '::placeholder': { color: cg.textMuted },
  },
  adornment: { display: 'inline-flex', flexShrink: 0, color: cg.textMuted, fontSize: '1.2em' },
  areaControl: { alignItems: 'stretch', paddingBlock: cg.space[3] },
  area: { resize: 'vertical', minHeight: '96px' },
  select: { appearance: 'none', cursor: 'pointer', paddingInlineEnd: cg.space[6] },
  selectWrap: { position: 'relative' },
  chevron: {
    position: 'absolute',
    insetInlineEnd: cg.space[3],
    top: '50%',
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
    color: cg.textMuted,
  },
});

interface ControlProps {
  /** Draws the control as invalid (set by `Field` when it has an error). */
  invalid?: boolean;
}

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, ControlProps {
  /** An icon at the start (a lucide icon), for example a search glass. */
  startIcon?: ReactNode;
  /** Anything at the end: a unit, a clear button. */
  endAdornment?: ReactNode;
  wrapperClassName?: string;
}

/** A text input: sunken surface, 12 px corners, an accent focus ring, 40 px tall (44 px on touch screens). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, startIcon, endAdornment, wrapperClassName, className, disabled, ...rest },
  ref,
) {
  const styles = useStyles();
  return (
    <span
      className={mergeClasses(
        styles.control,
        invalid && styles.invalid,
        disabled && styles.disabled,
        wrapperClassName,
      )}
    >
      {startIcon ? (
        <span aria-hidden="true" className={styles.adornment}>
          {startIcon}
        </span>
      ) : null}
      <input
        ref={ref}
        disabled={disabled}
        className={mergeClasses(styles.native, className)}
        {...rest}
      />
      {endAdornment}
    </span>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, ControlProps {
  wrapperClassName?: string;
}

/** A multi-line text field that the person can make taller. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, wrapperClassName, className, disabled, ...rest },
  ref,
) {
  const styles = useStyles();
  return (
    <span
      className={mergeClasses(
        styles.control,
        styles.areaControl,
        invalid && styles.invalid,
        disabled && styles.disabled,
        wrapperClassName,
      )}
    >
      <textarea
        ref={ref}
        disabled={disabled}
        className={mergeClasses(styles.native, styles.area, className)}
        {...rest}
      />
    </span>
  );
});

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>, ControlProps {
  wrapperClassName?: string;
}

/** A native select (the best choice on phones) in the same frame as `Input`. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, wrapperClassName, className, disabled, children, ...rest },
  ref,
) {
  const styles = useStyles();
  return (
    <span className={mergeClasses(styles.selectWrap, wrapperClassName)}>
      <span
        className={mergeClasses(
          styles.control,
          invalid && styles.invalid,
          disabled && styles.disabled,
        )}
      >
        <select
          ref={ref}
          disabled={disabled}
          className={mergeClasses(styles.native, styles.select, className)}
          {...rest}
        >
          {children}
        </select>
      </span>
      <ChevronDownIcon aria-hidden="true" className={styles.chevron} />
    </span>
  );
});

interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
  invalid?: boolean;
}

export interface FieldProps {
  /** Always visible. A placeholder is never a label. */
  label: ReactNode;
  /** One quiet line of help under the control. */
  hint?: ReactNode;
  /** Inline validation message: what is wrong and how to fix it. */
  error?: ReactNode;
  required?: boolean;
  /** The control: `Input`, `Textarea` or `Select`. */
  children: ReactElement<FieldControlProps>;
  className?: string;
}

/** Wires a label, a hint and an error message to one control (ids, `aria-describedby`, `aria-invalid`). */
export function Field({ label, hint, error, required = false, children, className }: FieldProps) {
  const styles = useStyles();
  const generated = useId();
  const id = children.props.id ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const control = cloneElement(children, {
    id,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true, invalid: true } : {}),
    ...(required ? { 'aria-required': true } : {}),
  });
  return (
    <div className={mergeClasses(styles.field, className)}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {required ? (
          <span aria-hidden="true" className={styles.required}>
            {' '}
            *
          </span>
        ) : null}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          <CircleAlertIcon aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
