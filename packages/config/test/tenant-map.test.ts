import { describe, expect, it } from 'vitest';
import { parseEntraTenantMap, validateConfig } from '../src';
import { ENTRA_TENANT, PRODUCTION_ENV } from './fixtures';

const SECOND_TENANT = '99999999-8888-7777-6666-555555555555';

describe('[NFR-SEC-01] parseEntraTenantMap: the Entra tenant -> CaseGuard tenant map', () => {
  it('returns the mapping in the order it was written', () => {
    const text = JSON.stringify({
      [SECOND_TENANT]: 'tenant_fabrikam_lab',
      [ENTRA_TENANT]: 'tenant_contoso_support',
    });
    const result = parseEntraTenantMap(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.entries(result.map)).toEqual([
      [SECOND_TENANT, 'tenant_fabrikam_lab'],
      [ENTRA_TENANT, 'tenant_contoso_support'],
    ]);
  });

  it('ignores whitespace around the value, as the environment loader does', () => {
    const text = `  \n${JSON.stringify({ [ENTRA_TENANT]: 'tenant_a' })}\t `;
    expect(parseEntraTenantMap(text)).toEqual({ ok: true, map: { [ENTRA_TENANT]: 'tenant_a' } });
  });

  it.each([[undefined], [''], ['   '], ['\n\t']])('reports %j as missing', (text) => {
    expect(parseEntraTenantMap(text)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['text that is not JSON', '{not json'],
    ['an empty object', '{}'],
    ['an array', `[{"${ENTRA_TENANT}":"tenant_a"}]`],
    ['null', 'null'],
    ['a string', '"tenant_a"'],
    ['a key that is not a GUID', '{"contoso":"tenant_a"}'],
    ['a tenant id with a space', `{"${ENTRA_TENANT}":"tenant a"}`],
    ['an empty tenant id', `{"${ENTRA_TENANT}":""}`],
    ['a tenant id that starts with punctuation', `{"${ENTRA_TENANT}":"_tenant"}`],
    ['a tenant id that is not a string', `{"${ENTRA_TENANT}":5}`],
    ['a tenant id longer than 120 characters', `{"${ENTRA_TENANT}":"${'a'.repeat(121)}"}`],
    ['a value above the 4000-character limit', `{"${ENTRA_TENANT}":"${'a'.repeat(4_000)}"}`],
  ])('reports %s as invalid', (_name, text) => {
    expect(parseEntraTenantMap(text)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never carries the text it was given, so a caller cannot echo it by accident', () => {
    const marker = 'super-secret-marker-7d1f';
    for (const text of [`{"${marker}":"tenant_a"}`, `{"${ENTRA_TENANT}":"${marker} x"}`, marker]) {
      expect(JSON.stringify(parseEntraTenantMap(text))).not.toContain(marker);
    }
  });

  it('accepts the same values as the full configuration and rejects the same values', () => {
    const entra = (text: string) => validateConfig({ ...PRODUCTION_ENV, ENTRA_TENANT_MAP: text });
    const samples = [
      JSON.stringify({ [ENTRA_TENANT]: 'tenant_contoso_support', [SECOND_TENANT]: 'tenant_b' }),
      '{}',
      '[]',
      '{not json',
      '{"contoso":"tenant_a"}',
      `{"${ENTRA_TENANT}":"tenant a"}`,
      '',
      '   ',
    ];
    for (const text of samples) {
      const helper = parseEntraTenantMap(text);
      const config = entra(text);
      const issue = config.ok
        ? undefined
        : config.issues.find((candidate) => candidate.variable === 'ENTRA_TENANT_MAP');
      expect(issue === undefined).toBe(helper.ok);
      if (!helper.ok) {
        expect(issue?.message).toMatch(
          helper.reason === 'missing'
            ? /^is required when AUTH_MODE=entra/
            : /^must be a non-empty/,
        );
      }
    }
  });
});
