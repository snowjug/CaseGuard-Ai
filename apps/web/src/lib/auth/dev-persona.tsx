'use client';

import { ROLE_LABELS, type Persona } from '@caseguard/schemas';
import {
  BadgeShell,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  Notice,
  cg,
  createPersistedStore,
  type PersistedStore,
} from '@caseguard/ui';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular, PersonWarningRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { describeError } from '../api/errors';
import { useApiQuery } from '../api/hooks';
import { useOverlayState } from '../use-overlay-state';
import { AuthContext, useAuth, type AuthContextValue } from './context';

export const PERSONA_STORAGE_KEY = 'cg-persona';
export const PERSONA_COOKIE = 'cg-persona';
const PERSONA_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

/** Accepts only well-formed persona ids from storage (never trust stored values). */
export function parsePersonaId(raw: string | null): string | null {
  return raw !== null && PERSONA_ID.test(raw) ? raw : null;
}

/** localStorage-backed selection. Exported as a factory so tests can inject their own storage. */
export function createPersonaStore(
  getStorage?: () => Storage | undefined,
): PersistedStore<string | null> {
  return createPersistedStore<string | null>({
    key: PERSONA_STORAGE_KEY,
    parse: parsePersonaId,
    serialize: (value) => value,
    ...(getStorage ? { getStorage } : {}),
  });
}

const defaultStore = createPersonaStore();

/** Persists the choice in a first-party `SameSite=Strict` cookie (development identity only), alongside localStorage. */
function writePersonaCookie(personaId: string | null): void {
  if (typeof document === 'undefined') return;
  document.cookie = personaId
    ? `${PERSONA_COOKIE}=${encodeURIComponent(personaId)}; Path=/; SameSite=Strict; Max-Age=604800`
    : `${PERSONA_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0`;
}

export interface DevPersonaAuthProviderProps {
  children: ReactNode;
  /** Injected for tests. */
  store?: PersistedStore<string | null>;
  writeCookie?: (personaId: string | null) => void;
}

/**
 * Development identity: the person picks one of the seeded synthetic personas and every API call carries
 * `x-cg-persona`. The API only honours it in local/test environments; production uses Entra ID.
 */
export function DevPersonaAuthProvider({
  children,
  store = defaultStore,
  writeCookie = writePersonaCookie,
}: DevPersonaAuthProviderProps) {
  const personaId = useSyncExternalStore(store.subscribe, store.get, () => null);
  const [pickerOpen, setPickerOpen] = useOverlayState();

  const selectPersona = useCallback(
    (next: string | null) => {
      store.set(next);
      writeCookie(next);
      setPickerOpen(false);
    },
    [store, writeCookie, setPickerOpen],
  );
  const getAuthHeaders = useCallback(
    async (): Promise<Record<string, string>> => (personaId ? { 'x-cg-persona': personaId } : {}),
    [personaId],
  );
  const openPicker = useCallback(() => setPickerOpen(true), [setPickerOpen]);
  const closePicker = useCallback(() => setPickerOpen(false), [setPickerOpen]);

  const value = useMemo<AuthContextValue>(
    () => ({
      mode: 'dev',
      status: personaId ? 'ready' : 'unauthenticated',
      identityKey: personaId ? `dev:${personaId}` : 'dev:none',
      getAuthHeaders,
      signOut: async () => selectPersona(null),
      dev: { personaId, selectPersona, pickerOpen, openPicker, closePicker },
    }),
    [personaId, getAuthHeaders, selectPersona, pickerOpen, openPicker, closePicker],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Badge that makes the development identity impossible to miss. */
export function DevIdentityBadge({ size = 'small' }: { size?: 'small' | 'medium' }) {
  return (
    <BadgeShell
      tone="uncertain"
      pattern="dots"
      icon={<PersonWarningRegular />}
      label="Development identity"
      size={size}
      borderStyle="dashed"
      title="Development identity: personas are synthetic and not real authentication"
    />
  );
}

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  option: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: cg.space[1],
    width: '100%',
    textAlign: 'left',
    padding: `${cg.space[3]} ${cg.space[4]}`,
    height: 'auto',
  },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  meta: { color: cg.textSecondary, fontSize: tokens.fontSizeBase200 },
  // The chosen persona is a filled (primary) button: the muted text colour has 1.4:1 contrast on it.
  metaOnBrand: { color: 'inherit' },
  content: { display: 'flex', flexDirection: 'column', gap: cg.space[3] },
});

/** Dialog that lists the seeded personas (`dev.personas`) and switches the identity. Render it once in the shell. */
export function PersonaPickerDialog() {
  const auth = useAuth();
  const dev = auth.dev;
  const styles = useStyles();
  const open = dev?.pickerOpen ?? false;
  const personas = useApiQuery('dev.personas', undefined, { enabled: open, staleTime: 5 * 60_000 });
  if (!dev) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => (data.open ? dev.openPicker() : dev.closePicker())}
    >
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<DismissRegular />}
                onClick={dev.closePicker}
              />
            }
          >
            Choose a development identity
          </DialogTitle>
          <DialogContent className={styles.content}>
            <Notice variant="warning" title="Development identity" compact>
              These personas are synthetic and exist only for local demos. Switching persona changes
              what you are allowed to do; it is not real sign-in.
            </Notice>
            {personas.isPending ? (
              <LoadingSkeleton variant="list" count={3} label="Loading personas" />
            ) : null}
            {personas.isError ? (
              <ErrorState
                title="Personas could not be loaded"
                description={describeError(personas.error)}
                error={{
                  status: personas.error.status,
                  code: personas.error.code,
                  correlationId: personas.error.correlationId,
                }}
                onRetry={() => void personas.refetch()}
                retrying={personas.isFetching}
                compact
              />
            ) : null}
            {personas.data && !personas.data.enabled ? (
              <EmptyState
                title="Development identity is disabled"
                description={personas.data.notice}
                compact
              />
            ) : null}
            {personas.data?.enabled ? (
              <>
                {personas.data.notice ? (
                  <p className={styles.meta}>{personas.data.notice}</p>
                ) : null}
                <ul className={styles.list} aria-label="Personas">
                  {personas.data.items.map((persona: Persona) => {
                    const chosen = persona.id === dev.personaId;
                    const meta = mergeClasses(styles.meta, chosen && styles.metaOnBrand);
                    return (
                      <li key={persona.id}>
                        <Button
                          className={styles.option}
                          appearance={chosen ? 'primary' : 'outline'}
                          aria-pressed={chosen}
                          onClick={() => dev.selectPersona(persona.id)}
                        >
                          <span className={styles.name}>
                            {persona.displayName} · {ROLE_LABELS[persona.role]}
                          </span>
                          <span className={meta}>{persona.description}</span>
                          <span className={meta}>Tenant: {persona.tenantId}</span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
