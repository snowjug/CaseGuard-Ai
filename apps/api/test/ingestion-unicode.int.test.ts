import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { TEST_DATABASE_STARTUP_TIMEOUT_MS } from '../src/db/testing';
import { bundleOf, secrets, transcriptOf } from './ingestion-fixtures';
import {
  CREATE_FILE_URL,
  PREVIEW_FILE_URL,
  createCase,
  csvWith,
  leakSurface,
  openHarness,
  openWarmDatabase,
  previewCase,
  resetDatabase,
  uploadFile,
} from './ingestion-support';
import { CONTOSO, PERSONAS, type ApiResponse, type Harness } from './support/app-harness';

/*
 * A secret or an e-mail address written with a no-break space, a zero-width space or a full-width colon
 * (what HTML, Teams and Outlook produce when text is copied) is redacted as the plain spelling is,
 * whichever way the text arrives, in the preview and in the stored case (review H1). Whatever stands
 * outside the redacted span stays as written.
 */

let database: Database;
const harnesses: Harness[] = [];

beforeAll(async () => {
  database = await openWarmDatabase();
}, TEST_DATABASE_STARTUP_TIMEOUT_MS);

afterAll(async () => {
  for (const h of harnesses) await h.close();
  await database.close();
});

beforeEach(() => resetDatabase(database));

const engineer = PERSONAS.engineer;
const PASSWORD = secrets.password(41);
const PLAIN_MAIL = 'ava.lee@customer.io';
const HIDDEN_MAIL = 'ava\u200B.lee@customer.io';
const PASSWORD_PLACEHOLDER = '[REDACTED:password_assignment]';
const MAIL_PLACEHOLDER = '[REDACTED:email_address#1]';

interface Variant {
  readonly name: string;
  readonly secret: string;
  readonly mail: string;
}

const variants: Variant[] = [
  { name: 'plain ASCII (the control)', secret: `password: ${PASSWORD}`, mail: PLAIN_MAIL },
  {
    name: 'a no-break space after the colon',
    secret: `password:\u00A0${PASSWORD}`,
    mail: PLAIN_MAIL,
  },
  {
    name: 'an ideographic space after the colon',
    secret: `password:\u3000${PASSWORD}`,
    mail: PLAIN_MAIL,
  },
  { name: 'a full-width colon', secret: `password\uFF1A ${PASSWORD}`, mail: PLAIN_MAIL },
  {
    name: 'zero-width spaces inside the keyword and the address',
    secret: `pass\u200Bword: ${PASSWORD}`,
    mail: HIDDEN_MAIL,
  },
  {
    name: 'all of it at once',
    secret: `p\u200Ba\u200Bs\u200Bs\u200Bw\u200Bo\u200Br\u200Bd\uFF1A\u00A0\u3000${PASSWORD}`,
    mail: HIDDEN_MAIL,
  },
];

const sentence = (variant: Variant): string =>
  `Before the change, ${variant.secret} and mail ${variant.mail}, after the change.`;

/** What a bundle must store: the secret and the address go, the spaces and the keyword stay as written. */
const expectedBody = (variant: Variant): string =>
  `Before the change, ${variant.secret.replace(PASSWORD, PASSWORD_PLACEHOLDER)} and mail ${MAIL_PLACEHOLDER}, after the change.`;

/**
 * The text parsers fold spacing and drop invisible characters before anything is redacted, and the
 * preview's excerpt is a display text with its spacing collapsed, so those comparisons ignore exactly
 * those differences. Only the stored text of a bundle is compared exactly.
 */
const folded = (text: string): string =>
  text
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u2007\u202F\u3000]/g, ' ')
    .replace(/\uFF1A/g, ':')
    .replace(/\s+/g, ' ');

async function expectNothingLeaked(h: Harness, ...responses: ApiResponse[]): Promise<void> {
  const surfaces = [...responses.map((res) => res.body), await leakSurface(h)];
  for (const surface of surfaces) {
    expect(surface).not.toContain(PASSWORD);
    expect(surface).not.toContain(PLAIN_MAIL);
    expect(surface).not.toContain(HIDDEN_MAIL);
  }
}

interface Way {
  readonly name: string;
  readonly preview: (h: Harness, body: string, index: number) => Promise<ApiResponse>;
  readonly create: (h: Harness, body: string, index: number) => Promise<ApiResponse>;
  /**
   * Whether the stored text must equal `expectedBody` exactly (a bundle is not rewritten by a parser)
   * and exactly two things were redacted. Pasted text and CSV also derive the case title from the
   * first message, so the same secret is redacted there as well.
   */
  readonly exact: boolean;
}

const bundleOfBody = (body: string, index: number) => ({
  type: 'bundle',
  bundle: bundleOf({ reference: `CG-UNI-10${index}`, body }),
});
const pastedText = (body: string) => ({
  type: 'paste',
  text: transcriptOf([body, 'Please send two failed sign-in times.']),
  workload: 'teams-authentication',
});

const ways: Way[] = [
  {
    name: 'a JSON bundle',
    preview: (h, body, index) => previewCase(h, engineer, bundleOfBody(body, index)),
    create: (h, body, index) => createCase(h, engineer, bundleOfBody(body, index)),
    exact: true,
  },
  {
    name: 'a pasted transcript',
    preview: (h, body) => previewCase(h, engineer, pastedText(body)),
    create: (h, body) => createCase(h, engineer, pastedText(body)),
    exact: false,
  },
  {
    name: 'a CSV file',
    preview: (h, body) =>
      uploadFile(h, engineer, PREVIEW_FILE_URL, 'events.csv', csvWith(body), 'text/csv'),
    create: (h, body) =>
      uploadFile(h, engineer, CREATE_FILE_URL, 'events.csv', csvWith(body), 'text/csv'),
    exact: false,
  },
];

const CATEGORIES = ['email_address', 'password_assignment'];
const sorted = (categories: readonly string[]): string[] => [...categories].sort();

describe.each(ways)('$name', (way) => {
  it.each(variants.map((variant, index) => ({ ...variant, index })))(
    'redacts $name in the preview and in the stored case',
    async (variant) => {
      const { h } = await openHarness(database, harnesses);
      const body = sentence(variant);

      const preview = await way.preview(h, body, variant.index);
      expect(preview.statusCode).toBe(200);
      expect(preview.data.ok).toBe(true);
      const replacements: number = preview.data.redaction.totalReplacements;
      if (way.exact) expect(replacements).toBe(2);
      else expect(replacements).toBeGreaterThanOrEqual(2);
      expect(
        sorted(
          preview.data.redaction.findings.map((finding: { category: string }) => finding.category),
        ),
      ).toEqual(CATEGORIES);
      const excerpt: string = preview.data.eventsPreview[0].bodyExcerpt;
      expect(folded(excerpt)).toBe(folded(expectedBody(variant)));

      const created = await way.create(h, body, variant.index);
      expect(created.statusCode).toBe(201);
      expect(created.data.preview.redaction.totalReplacements).toBe(replacements);
      const [first] = await h.repos(CONTOSO).cases.getAllEvents(created.data.case.id);
      expect(folded(first?.body ?? '')).toBe(folded(expectedBody(variant)));
      if (way.exact) expect(first?.body).toBe(expectedBody(variant));
      expect(first?.redaction.redacted).toBe(true);
      expect(sorted(first?.redaction.categories ?? [])).toEqual(CATEGORIES);
      // What stands outside the spans is exactly as it was sent.
      expect(first?.body.startsWith('Before the change, ')).toBe(true);
      expect(first?.body.endsWith(', after the change.')).toBe(true);

      await expectNothingLeaked(h, preview, created);
    },
  );
});
