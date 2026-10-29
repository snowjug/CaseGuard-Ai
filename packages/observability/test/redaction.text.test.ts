import { describe, expect, it, vi } from 'vitest';
import { createScrubber, REDACTED, scrubText, TRUNCATION_MARKER } from '../src';
import { fakeSecrets } from './helpers/secrets';

const secrets = fakeSecrets();

function expectNoCores(output: string, cores: readonly string[]): void {
  for (const core of cores) expect(output).not.toContain(core);
}

describe('scrubText: credential and PII shapes', () => {
  it.each(secrets.map((secret) => [secret.id, secret] as const))(
    '[NFR-SEC-06] [NFR-OBS-01] %s never survives, alone, embedded or multi-line',
    (_id, secret) => {
      const variants = [
        secret.text,
        `before ${secret.text} after`,
        `line one\n${secret.text}\nline three`,
        `${secret.text}.`,
        JSON.stringify({ message: secret.text }),
        JSON.stringify({ nested: { list: [secret.text] } }),
        `"${secret.text}"`,
        `(${secret.text})`,
      ];
      for (const variant of variants) {
        const output = scrubText(variant);
        expectNoCores(output, secret.cores);
        expect(output).toContain('[REDACTED');
      }
    },
  );

  it.each(secrets.map((secret) => [secret.id, secret] as const))(
    '[NFR-OBS-01] %s redaction is idempotent',
    (_id, secret) => {
      const once = scrubText(`ctx ${secret.text} end`);
      expect(scrubText(once)).toBe(once);
    },
  );

  it('[NFR-SEC-06] redacts a JSON string that was itself JSON-encoded (escaped quotes)', () => {
    const inner = JSON.stringify({ password: 'fakeDoubleEncoded99', ok: true });
    const output = scrubText(JSON.stringify(inner));
    expect(output).not.toContain('fakeDoubleEncoded99');
  });

  it('[NFR-SEC-06] redacts every value of a connection string but keeps non-secret context', () => {
    const output = scrubText(
      'Server=tcp:fake-db.example.test,1433;Database=cg;User Id=svc_fake;Password=Fake-Pa55w0rd-9x;Encrypt=true',
    );
    expect(output).toContain('Server=tcp:fake-db.example.test,1433');
    expect(output).toContain('Database=cg');
    expect(output).toContain('Encrypt=true');
    expect(output).not.toContain('Fake-Pa55w0rd-9x');
  });

  it('[NFR-SEC-06] keeps the SAS permissions and expiry but drops the signature', () => {
    const output = scrubText(
      'GET https://fakeacct.blob.core.windows.net/c/b?sv=2022-11-02&sp=r&se=2030-01-01&sig=ZmFrZQ%3D%3Dfake&x=1',
    );
    expect(output).toContain('sp=r');
    expect(output).toContain('se=2030-01-01');
    expect(output).toContain('x=1');
    expect(output).not.toContain('ZmFrZQ');
  });

  it('[NFR-SEC-06] collapses an Authorization header with scheme and token into one placeholder', () => {
    expect(scrubText('Authorization: Bearer fakeBearerToken0123456789abcdef')).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it('[NFR-SEC-06] keeps JSON quoting intact when redacting quoted values', () => {
    expect(scrubText('{"password":"fakeHunter2Value","ok":true}')).toBe(
      `{"password":"${REDACTED}","ok":true}`,
    );
  });

  it('[NFR-SEC-06] masks SSN-like numbers and Luhn-valid payment cards, not arbitrary digit runs', () => {
    expect(scrubText('ssn 123-45-6789 on file')).toBe('ssn [REDACTED:ssn] on file');
    expect(scrubText('card 4111 1111 1111 1111 declined')).toBe('card [REDACTED:card] declined');
    expect(scrubText('card 4111-1111-1111-1111 declined')).toBe('card [REDACTED:card] declined');
    // Fails Luhn, wrong issuer prefix, or just an id: none of these are cards.
    expect(scrubText('order 4111 1111 1111 1112 queued')).toContain('4111 1111 1111 1112');
    expect(scrubText('epoch 1761731234123456 logged')).toContain('1761731234123456');
  });

  it('[NFR-SEC-06] masks user names inside file paths but keeps the rest of the path', () => {
    expect(scrubText('ENOENT open C:\\Users\\alice\\proj\\a.ts')).toBe(
      'ENOENT open C:\\Users\\[REDACTED]\\proj\\a.ts',
    );
    expect(scrubText('at /home/bob/work/a.ts:3')).toBe('at /home/[REDACTED]/work/a.ts:3');
  });

  it('[NFR-SEC-06] can leave PII alone when disabled, while credentials are always redacted', () => {
    const scrubber = createScrubber({ pii: false });
    expect(scrubber.text('mail fake.person@example.test')).toBe('mail fake.person@example.test');
    expect(scrubber.text('password=fakeHunter2Value')).not.toContain('fakeHunter2Value');
  });
});

describe('scrubText: legitimate telemetry is left alone', () => {
  const benign = [
    'GET /api/v1/cases/case_01HZX8Y9ABCDEFGHJKMNPQRSTV completed in 12ms',
    'pino@10.4.0 installed, vitest@4.1.12 ready',
    'promptTokens=120 completionTokens=48 totalTokens: 168 maxTokens: 4000 tokenCount=5',
    'traceId=4bf92f3577b34da6a3ce929d0e0e4736 spanId=00f067aa0ba902b7',
    'sha256 prevHash=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'request 7b1c1f2e-5d3a-4c9b-8f10-2a6d9e4b5c31 accepted',
    'at 2026-10-29T09:14:14.599Z user_ava_engineer in tenant_contoso_support',
    'Basic configuration loaded; Bearer authentication enabled',
    'The design is signed off; signature verification passed',
    'cursor eyJpZCI6ImNhc2VfMDEifQ is opaque',
    'idempotencyKey: abc-123 cacheKey: case:42',
    'secretary of state; tokenizer ready',
  ];

  it.each(benign.map((text) => [text] as const))('[NFR-OBS-01] keeps %s', (text) => {
    expect(scrubText(text)).toBe(text);
  });
});

describe('scrubText: bounds and fail-closed behaviour', () => {
  it('[NFR-OBS-01] truncates long text with a marker and respects the requested limit', () => {
    const scrubber = createScrubber({ maxStringLength: 64 });
    const output = scrubber.text('x'.repeat(500));
    expect(output.length).toBeLessThanOrEqual(64);
    expect(output.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(scrubber.text(output)).toBe(output);
  });

  it('[NFR-SEC-06] never leaves half a token behind when the scan window cuts through one', () => {
    const token = `eyJ${'a'.repeat(40)}.eyJ${'b'.repeat(40)}.${'c'.repeat(40)}`;
    // 32 750 characters of filler put the 32 768-character scan limit inside the token.
    const text = `${'word '.repeat(6550)}${token} trailing`;
    const output = createScrubber({ maxStringLength: 1_000_000 }).text(text);
    expect(output).not.toContain('eyJ');
    expect(output).not.toContain('bbbbbbbb');
    expect(output.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('[NFR-SEC-06] applies an injected redactor after the built-in rules', () => {
    const scrubber = createScrubber({
      redact: (text) => text.replace(/internal-codename/g, '[CODENAME]'),
    });
    expect(scrubber.text('project internal-codename uses password=fakeHunter2Value')).toBe(
      `project [CODENAME] uses password=${REDACTED}`,
    );
  });

  it('[NFR-SEC-06] fails closed when the injected redactor throws and reports the error', () => {
    const onError = vi.fn();
    const scrubber = createScrubber({
      redact: () => {
        throw new Error('redactor exploded');
      },
      onError,
    });
    const output = scrubber.text('sensitive free text that must not survive a broken redactor');
    expect(output).toBe('[REDACTED:redactor-failed]');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('[NFR-SEC-06] fails closed when the injected redactor returns a non-string', () => {
    const scrubber = createScrubber({ redact: (() => 42) as unknown as (text: string) => string });
    expect(scrubber.text('text')).toBe('[REDACTED:redactor-failed]');
  });

  it('[NFR-OBS-01] reports which rule fired, never the matched value', () => {
    const onRedaction = vi.fn();
    const scrubber = createScrubber({ onRedaction });
    scrubber.text('password=fakeHunter2Value and fake.person@example.test');
    const rules = onRedaction.mock.calls.map((call) => call[0] as string);
    expect(rules).toEqual(expect.arrayContaining(['secret-assignment', 'email']));
    expect(JSON.stringify(onRedaction.mock.calls)).not.toContain('fakeHunter2Value');
  });
});
