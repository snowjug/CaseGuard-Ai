'use client';

import {
  RedactionConfigSchema,
  type GovernanceSettings,
  type RedactionCategory,
} from '@caseguard/schemas';
import { Notice, cg } from '@caseguard/ui';
import { Button, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { AddRegular, DeleteRegular } from '@fluentui/react-icons';
import { FieldGrid, FieldGroup, SwitchField, TextField, useEditor } from './fields';
import { getIn } from './messages';
import { SectionEditor } from './SectionEditor';

const useStyles = makeStyles({
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  row: {
    display: 'grid',
    gap: cg.space[2],
    alignItems: 'start',
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto' },
  },
  muted: { margin: 0, fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  list2: {
    margin: `${cg.space[1]} 0 0`,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
  },
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

function Categories() {
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
      <FieldGroup
        title="Credentials (always redacted)"
        description="Secrets such as tokens, keys and connection strings are always removed before text is stored. They cannot be turned off."
      >
        <FieldGrid>
          {SECRET_CATEGORIES.map((category) => (
            <div key={category}>
              <SwitchFixed label={CATEGORY_LABELS[category] ?? category} />
            </div>
          ))}
        </FieldGrid>
      </FieldGroup>
      <FieldGroup
        title="Personal data (your choice)"
        description="Replaced by numbered placeholders so analysis can still tell two values apart."
      >
        <FieldGrid>
          {PERSONAL_CATEGORIES.map((category) => (
            <PersonalSwitch
              key={category}
              label={CATEGORY_LABELS[category] ?? category}
              checked={enabled.has(category)}
              disabled={disabled}
              onChange={(on) => toggle(category, on)}
            />
          ))}
        </FieldGrid>
      </FieldGroup>
    </>
  );
}

function SwitchFixed({ label }: { label: string }) {
  return <Switch label={label} checked disabled aria-label={`${label}: always on`} />;
}

function PersonalSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      label={label}
      checked={checked}
      disabled={disabled}
      onChange={(_event, data) => onChange(data.checked)}
    />
  );
}

const MAX_PATTERNS = 20;

function CustomPatterns() {
  const styles = useStyles();
  const { draft, set, disabled } = useEditor();
  const raw = getIn(draft, 'customPatterns');
  const patterns = Array.isArray(raw) ? (raw as readonly unknown[]) : [];
  return (
    <FieldGroup
      title="Custom patterns"
      description="Extra tenant patterns (regular expressions) replaced with [REDACTED:custom] in text you ingest."
    >
      <Notice variant="warning" title="Custom patterns can be refused">
        A pattern runs on text you do not control, in an engine that can backtrack for a very long
        time. Each pattern is checked when you save it (length, syntax, matching empty text, nested
        repetition, back-references and a timed probe on hostile input) and again, with a hard time
        limit, at ingestion. A pattern that is unsafe or too slow is refused with the reason. At
        ingestion a pattern that fails, or runs out of time, means redaction would be incomplete, so
        the whole payload is refused instead of being stored partly redacted.
      </Notice>
      <p className={styles.muted}>
        {patterns.length} of {MAX_PATTERNS} patterns used. Names up to 60 characters, patterns up to
        200.
      </p>
      {patterns.length > 0 ? (
        <ul className={styles.list} aria-label="Custom redaction patterns">
          {patterns.map((_pattern, index) => (
            <li key={index} className={styles.row}>
              <TextField path={`customPatterns.${index}.name`} label="Name" maxLength={60} />
              <TextField path={`customPatterns.${index}.pattern`} label="Pattern" maxLength={200} />
              <Button
                appearance="subtle"
                icon={<DeleteRegular />}
                disabled={disabled}
                aria-label={`Remove custom pattern ${index + 1}`}
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
      <div>
        <Button
          appearance="outline"
          icon={<AddRegular />}
          disabled={disabled || patterns.length >= MAX_PATTERNS}
          onClick={() => set('customPatterns', [...patterns, { name: '', pattern: '' }])}
        >
          Add a pattern
        </Button>
      </div>
    </FieldGroup>
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
      <Categories />
      <CustomPatterns />
      <FieldGroup title="Other">
        <FieldGrid columns={2}>
          <div>
            <SwitchField
              path="redactBeforeModelCalls"
              label="Redact before model calls"
              hint="Recorded only: nothing reads this switch, so turning it off does not change when text is redacted."
            />
          </div>
          <TextField path="version" label="Version label" maxLength={40} hint="Free text." />
        </FieldGrid>
        <ul className={styles.list2} aria-label="Placeholders">
          <li className={styles.muted}>
            Credentials become [REDACTED:category]; personal data becomes [REDACTED:category#n].
          </li>
        </ul>
      </FieldGroup>
    </SectionEditor>
  );
}
