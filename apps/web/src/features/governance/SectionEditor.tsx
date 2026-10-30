'use client';

import type { GovernanceSection, GovernanceSettings } from '@caseguard/schemas';
import { Notice, Panel, cg, formatDateTimeUtc } from '@caseguard/ui';
import { Button, Field, Input, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowUndoRegular, SaveRegular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import type { ZodType } from 'zod';
import { ApiError, describeError } from '../../lib/api/errors';
import { useApiMutation } from '../../lib/api/hooks';
import { invalidateRoutes } from '../../lib/api/query-keys';
import { useAuth } from '../../lib/auth/context';
import { useSession } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { EditorProvider, type EditorState } from './fields';
import { NOTE_KEY, WHOLE_KEY, deepEqual, issuesToErrors, sentence, setIn } from './messages';

const useStyles = makeStyles({
  fields: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  meta: {
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: `${cg.space[1]} ${cg.space[3]}`,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    paddingTop: cg.space[3],
    borderTop: `1px solid ${cg.borderSubtle}`,
  },
  note: { maxWidth: '640px' },
  buttons: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: cg.space[2] },
  hint: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  problems: {
    margin: `${cg.space[1]} 0 0`,
    paddingLeft: cg.space[4],
    fontSize: tokens.fontSizeBase300,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  code: { fontFamily: cg.font.mono, fontSize: tokens.fontSizeBase200 },
});

const MIN_NOTE = 5;
const MAX_ISSUES_SHOWN = 8;

export interface SectionEditorProps<S extends GovernanceSection> {
  section: S;
  envelope: GovernanceSettings[S];
  /** Checked before saving so a mistake is caught early; the API validates again and stays the authority. */
  schema: ZodType;
  title: string;
  description: ReactNode;
  help?: ReactNode;
  /** `enforced`: the application reads this section. `recorded`: it is stored and audited but nothing reads it yet. */
  effect: 'enforced' | 'recorded';
  effectNote: ReactNode;
  /** Rules the schema cannot express (bands that must descend); returns problems by dotted path. */
  extraErrors?: (draft: GovernanceSettings[S]['value']) => Record<string, string>;
  children: ReactNode;
}

/**
 * One versioned section of the governed configuration: its metadata, an honest note on whether anything enforces it,
 * the fields, and a save that sends `expectedVersion` with a mandatory change note. A 422 shows the API's problems per
 * field, a 409 says someone else saved first and offers the latest version; nothing is saved silently over another
 * person's change. The parent renders it with `key={version}` so a new version always starts from a clean draft.
 */
export function SectionEditor<S extends GovernanceSection>({
  section,
  envelope,
  schema,
  title,
  description,
  help,
  effect,
  effectNote,
  extraErrors,
  children,
}: SectionEditorProps<S>) {
  const styles = useStyles();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const canWrite = can('governance:write');
  const update = useApiMutation('governance.update', { invalidate: ['governance.get'] });

  const [draft, setDraft] = useState<GovernanceSettings[S]['value']>(envelope.value);
  const [note, setNote] = useState('');
  const [noteTouched, setNoteTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const dirty = !deepEqual(draft, envelope.value);
  const clientErrors = useMemo(() => {
    const parsed = schema.safeParse(draft);
    return {
      ...(parsed.success ? {} : issuesToErrors(parsed.error.issues)),
      ...(extraErrors?.(draft) ?? {}),
    };
  }, [schema, draft, extraErrors]);
  const errors = { ...serverErrors, ...clientErrors };
  const invalid = Object.keys(clientErrors).length > 0;
  const noteTooShort = note.trim().length < MIN_NOTE;
  const saving = update.isPending;

  const state: EditorState = {
    draft,
    disabled: saving || !canWrite,
    errors,
    set: (path, value) => {
      setDraft((previous) => setIn(previous, path, value));
      setServerErrors((previous) => {
        if (!(path in previous)) return previous;
        const { [path]: _cleared, ...rest } = previous;
        return rest;
      });
      setFailure(null);
    },
  };

  const discard = (): void => {
    setDraft(envelope.value);
    setNote('');
    setNoteTouched(false);
    setServerErrors({});
    setConflict(null);
    setFailure(null);
    setEpoch((value) => value + 1);
  };

  const save = async (): Promise<void> => {
    setNoteTouched(true);
    if (invalid || noteTooShort || !dirty) return;
    setServerErrors({});
    setConflict(null);
    setFailure(null);
    try {
      await update.mutateAsync({
        params: { section },
        body: { value: draft, expectedVersion: envelope.version, changeNote: note.trim() },
      });
      toast.success(`${title} saved as version ${envelope.version + 1}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'version_conflict') {
        setConflict(error.message);
      } else if (error instanceof ApiError && error.status === 422) {
        setServerErrors(issuesToErrors(error.issues));
        setFailure(
          error.issues.length === 0
            ? error.message
            : `The API refused these settings (${error.issues.length} ${error.issues.length === 1 ? 'problem' : 'problems'}). Nothing was saved.`,
        );
      } else {
        setFailure(`${sentence(describeError(error))} Nothing was saved.`);
      }
    }
  };

  const loadLatest = async (): Promise<void> => {
    await invalidateRoutes(queryClient, auth.identityKey, ['governance.get']);
    discard();
  };

  const shownProblems = Object.entries(serverErrors).slice(0, MAX_ISSUES_SHOWN);
  const noteError =
    serverErrors[NOTE_KEY] ??
    (noteTouched && noteTooShort
      ? `Describe the change in at least ${MIN_NOTE} characters.`
      : undefined);
  const wholeError = errors[WHOLE_KEY];

  return (
    <Panel title={title} description={description} help={help}>
      <p className={styles.meta}>
        <strong>Version {envelope.version}</strong>
        <span>
          Changed {formatDateTimeUtc(envelope.updatedAt)} by {envelope.updatedBy}
        </span>
        <span>Change note: {envelope.changeNote || 'none'}</span>
      </p>
      <Notice
        variant={effect === 'enforced' ? 'info' : 'warning'}
        compact
        title={effect === 'enforced' ? 'Enforced' : 'Recorded only'}
      >
        {effectNote}
      </Notice>
      <EditorProvider value={state}>
        <div key={epoch} className={styles.fields}>
          {children}
        </div>
      </EditorProvider>
      {wholeError ? (
        <p role="alert" className={styles.hint}>
          {wholeError}
        </p>
      ) : null}
      {conflict ? (
        <div role="alert">
          <Notice
            variant="warning"
            title="Someone else saved first"
            action={
              <Button appearance="primary" onClick={() => void loadLatest()}>
                Load the latest version
              </Button>
            }
          >
            {conflict} You started from version {envelope.version}. Your changes were not saved;
            loading the latest version replaces them, so copy anything you need first.
          </Notice>
        </div>
      ) : null}
      {failure ? (
        <div role="alert">
          <Notice variant="warning" title="Not saved">
            {failure}
            {shownProblems.length > 0 ? (
              <ul className={styles.problems} aria-label="Problems reported by the API">
                {shownProblems.map(([path, message]) => (
                  <li key={path}>
                    <span className={styles.code}>
                      {path === NOTE_KEY ? 'changeNote' : path === WHOLE_KEY ? 'value' : path}
                    </span>
                    : {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        </div>
      ) : null}
      {canWrite ? (
        <div className={styles.footer}>
          <Field
            className={styles.note}
            label="Change note"
            required
            hint="Stored with the new version so the next person sees why it changed."
            validationState={noteError ? 'error' : 'none'}
            validationMessage={noteError}
          >
            <Input
              value={note}
              maxLength={500}
              disabled={saving}
              onChange={(_event, data) => setNote(data.value)}
              onBlur={() => setNoteTouched(true)}
            />
          </Field>
          <div className={styles.buttons}>
            <Button
              appearance="primary"
              icon={<SaveRegular />}
              disabledFocusable={!dirty || saving || invalid}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            <Button
              appearance="subtle"
              icon={<ArrowUndoRegular />}
              disabledFocusable={!dirty || saving}
              onClick={discard}
            >
              Discard changes
            </Button>
            <p className={styles.hint} role="status">
              {!dirty
                ? 'No changes yet.'
                : invalid
                  ? 'Fix the highlighted settings to save.'
                  : 'Unsaved changes.'}
            </p>
          </div>
        </div>
      ) : (
        <Notice variant="info" compact title="View only">
          Your role can read this section but not change it. Changing configuration needs the
          governance:write permission.
        </Notice>
      )}
    </Panel>
  );
}
