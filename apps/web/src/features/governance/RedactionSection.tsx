'use client';

import {
  RedactionConfigSchema,
  type GovernanceSettings,
  type RedactionCategory,
} from '@caseguard/schemas';
import { Accordion, Button, HelpButton, IconButton, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { FieldGroup, SwitchField, SwitchRow, TextField, useEditor } from './fields';
import { getIn } from './messages';
import { SectionEditor } from './SectionEditor';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  row: {
    display: 'grid',
    gap: cg.space[3],
    alignItems: 'end',
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto' },
  },
  head: { display: 'flex', alignItems: 'flex-start', gap: cg.space[1] },
  muted: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
  },
  add: { paddingTop: cg.space[3] },
});

/**
 * Credential categories are always redacted: the API refuses a section that turns one off, and ingestion adds them back
 * regardless. The list here only lets the switches show it; the API stays the authority.
 */
const SECRET_CATEGORIES: readonly RedactionCategory[] = [
  'bearer_token',
  'api_key',
  'connection_string',
  'private_key',
  'password_assignment',
  'jwt',
  'github_token',
  'azure_storage_key',
];
const PERSONAL_CATEGORIES: readonly RedactionCategory[] = [
  'email_address',
  'ipv4_address',
  'phone_number',
];

const CATEGORY_LABELS: Partial<Record<RedactionCategory, string>> = {
  bearer_token: 'Bearer tokens',
  api_key: 'API keys',
  connection_string: 'Connection strings',
  private_key: 'Private keys',
  password_assignment: 'Password assignments',
  jwt: 'JSON web tokens',
  github_token: 'GitHub tokens',
  azure_storage_key: 'Azure storage keys',
  email_address: 'Email addresses',
  ipv4_address: 'IPv4 addresses',
  phone_number: 'Phone numbers',
};

const CATEGORY_ORDER: readonly RedactionCategory[] = [...SECRET_CATEGORIES, ...PERSONAL_CATEGORIES];

function PersonalData() {
  const { draft, set, disabled } = useEditor();
  const raw = getIn(draft, 'enabledCategories');
  const enabled = new Set<RedactionCategory>(
    Array.isArray(raw) ? (raw as RedactionCategory[]) : [],
  );
  const toggle = (category: RedactionCategory, on: boolean): void => {
    const next = new Set(enabled);
    if (on) next.add(category);
    else next.delete(category);
    // Keep the canonical order so an unchanged selection is never reported as a change.
    set('enabledCategories', [
      ...CATEGORY_ORDER.filter((item) => next.has(item)),
      ...[...next].filter((item) => !CATEGORY_ORDER.includes(item)),
    ]);
  };
  return (
    <>
      {PERSONAL_CATEGORIES.map((category) => (
        <SwitchRow
          key={category}
          label={CATEGORY_LABELS[category] ?? category}
          checked={enabled.has(category)}
          disabled={disabled}
          onChange={(on) => toggle(category, on)}
        />
      ))}
    </>
  );
}

const MAX_PATTERNS = 20;

function CustomPatterns() {
  const styles = useStyles();
  const { draft, set, disabled } = useEditor();
  const raw = getIn(draft, 'customPatterns');
  const patterns = Array.isArray(raw) ? (raw as readonly unknown[]) : [];
  return (
    <>
      <div className={styles.head}>
        <p className={styles.muted}>
          Custom patterns can be refused. Each pattern is checked when you save it and again, with a
          time limit, at ingestion: one that is unsafe, can backtrack for a very long time, or is
          too slow is refused with the reason. If a pattern fails or runs out of time at ingestion,
          redaction would be incomplete, so the whole payload is refused instead of being stored
          partly redacted.
        </p>
        <HelpButton label="About custom patterns" title="Custom patterns">
          A pattern runs on text you do not control, in an engine that can backtrack for a very long
          time. Each pattern is checked for length, syntax, matching empty text, nested repetition,
          back-references and with a timed probe on hostile input.
        </HelpButton>
      </div>
      <p className={styles.muted}>
        {patterns.length} of {MAX_PATTERNS} patterns used. Names up to 60 characters, patterns up to
        200. Matches are replaced with [REDACTED:custom].
      </p>
      {patterns.length > 0 ? (
        <ul className={styles.list} aria-label="Custom redaction patterns">
          {patterns.map((_pattern, index) => (
            <li key={index} className={styles.row}>
              <TextField
                stacked
                path={`customPatterns.${index}.name`}
                label="Name"
                maxLength={60}
              />
              <TextField
                stacked
                path={`customPatterns.${index}.pattern`}
                label="Pattern"
                maxLength={200}
              />
              <IconButton
                icon={<Trash2Icon />}
                label={`Remove custom pattern ${index + 1}`}
                disabled={disabled}
                onClick={() =>
                  set(
                    'customPatterns',
                    patterns.filter((_item, position) => position !== index),
                  )
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>
          No custom patterns. The built-in categories above still apply.
        </p>
      )}
      <div className={styles.add}>
        <Button
          variant="secondary"
          icon={<PlusIcon />}
          disabled={disabled || patterns.length >= MAX_PATTERNS}
          onClick={() => set('customPatterns', [...patterns, { name: '', pattern: '' }])}
        >
          Add a pattern
        </Button>
      </div>
    </>
  );
}

/** Redaction (`redaction` section): which categories are removed from ingested text, and tenant patterns. */
export function RedactionSection({ envelope }: { envelope: GovernanceSettings['redaction'] }) {
  const styles = useStyles();
  return (
    <SectionEditor
      section="redaction"
      envelope={envelope}
      schema={RedactionConfigSchema}
      title="Redaction"
      description="What is removed from case text before it is stored."
      help="Redaction replaces secrets and personal data with placeholders such as [REDACTED:email_address#1] so analysis keeps working without the sensitive value. Credential categories are mandatory; personal data and custom patterns are a tenant choice. If redaction cannot be completed, the payload is refused rather than stored half-redacted."
      effect="enforced"
      effectNote="Applied to cases ingested after the change; text already stored is not redacted again. An incomplete redaction (a pattern that fails or times out) refuses the payload."
    >
      <Accordion>
        <FieldGroup
          title="Personal data (your choice)"
          description="Replaced by numbered placeholders so analysis can still tell two values apart."
          paths={['enabledCategories']}
          defaultOpen
        >
          <PersonalData />
        </FieldGroup>
        <FieldGroup title="Custom patterns" paths={['customPatterns']}>
          <CustomPatterns />
        </FieldGroup>
        <FieldGroup
          title="Credentials (always redacted)"
          description="Secrets such as tokens, keys and connection strings are always removed before text is stored. They cannot be turned off."
        >
          {SECRET_CATEGORIES.map((category) => (
            <SwitchRow
              key={category}
              label={CATEGORY_LABELS[category] ?? category}
              hint="Always on"
              checked
              disabled
            />
          ))}
        </FieldGroup>
        <FieldGroup title="Other" paths={['redactBeforeModelCalls', 'version']}>
          <SwitchField
            path="redactBeforeModelCalls"
            label="Redact before model calls"
            hint="Recorded only: nothing reads this switch, so turning it off does not change when text is redacted."
          />
          <TextField path="version" label="Version label" maxLength={40} hint="Free text." />
          <ul className={styles.list} aria-label="Placeholders">
            <li className={styles.muted}>
              Credentials become [REDACTED:category]; personal data becomes [REDACTED:category#n].
            </li>
          </ul>
        </FieldGroup>
      </Accordion>
    </SectionEditor>
  );
}
