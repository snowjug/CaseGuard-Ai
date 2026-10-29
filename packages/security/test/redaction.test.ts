import { describe, expect, it } from 'vitest';
import { REDACTION_CATEGORIES, type RedactionCategory } from '@caseguard/schemas';
import { createPseudonymState, type PseudonymCategory } from '../src/redaction/pseudonyms';
import {
  DEFAULT_REDACTION_OPTIONS,
  SECRET_REDACTION_CATEGORIES,
  redactText,
} from '../src/redaction/redact-text';
import { isNonRoutableIpv4, isReservedEmailDomain } from '../src/redaction/synthetic';
import { B62, concat, fixture, secrets } from './helpers/secrets';

const redact = (text: string, options = {}) => redactText(text, options);
const countOf = (result: ReturnType<typeof redactText>, category: RedactionCategory): number =>
  result.findings.find((finding) => finding.category === category)?.count ?? 0;

describe('redactText: credentials (FR-ING-04, NFR-PRIV-01)', () => {
  it('redacts bearer tokens and keeps the header context', () => {
    const token = secrets.bearerToken();
    const result = redact(
      `GET /api HTTP/1.1\nAuthorization: Bearer ${token}\nHost: contoso.example`,
    );
    expect(result.text).toBe(
      'GET /api HTTP/1.1\nAuthorization: Bearer [REDACTED:bearer_token]\nHost: contoso.example',
    );
    expect(result.findings).toEqual([
      { category: 'bearer_token', count: 1, placeholder: '[REDACTED:bearer_token]' },
    ]);
    expect(result.totalReplacements).toBe(1);
  });

  it('redacts short header credentials, Basic auth and cookies', () => {
    const basic = fixture(24, B62, 2);
    const result = redact(
      [
        'Authorization: Bearer abcd1234',
        `Proxy-Authorization: Basic ${basic}`,
        `Cookie: sessionid=${fixture(20, B62, 3)}; theme=dark`,
        `Set-Cookie: .AspNet.Auth=${fixture(30, B62, 4)}; path=/; secure`,
      ].join('\n'),
    );
    expect(result.text).toBe(
      [
        'Authorization: Bearer [REDACTED:bearer_token]',
        'Proxy-Authorization: Basic [REDACTED:bearer_token]',
        'Cookie: [REDACTED:bearer_token]',
        'Set-Cookie: [REDACTED:bearer_token]',
      ].join('\n'),
    );
    expect(countOf(result, 'bearer_token')).toBe(4);
  });

  it('leaves prose that merely mentions bearers alone', () => {
    const text = 'The bearer of this letter may sign. Bearer authentication is enabled.';
    expect(redact(text).text).toBe(text);
  });

  it('redacts JWTs, including inside URLs', () => {
    const jwt = secrets.jwt();
    const result = redact(
      `token passed as https://app.contoso.example/cb#id_token=${jwt}&state=1 then ${jwt}`,
    );
    expect(result.text).not.toContain(jwt);
    expect(countOf(result, 'jwt')).toBe(2);
    expect(result.text).toContain('[REDACTED:jwt]');
  });

  it('redacts GitHub tokens (classic and fine-grained)', () => {
    const result = redact(`push with ${secrets.githubToken()} or ${secrets.githubPat()}`);
    expect(result.text).toBe('push with [REDACTED:github_token] or [REDACTED:github_token]');
  });

  it('redacts provider API keys wherever they appear', () => {
    const keys = [
      secrets.openAiKey(),
      secrets.awsAccessKeyId(),
      secrets.googleKey(),
      secrets.slackToken(),
      secrets.stripeKey(),
      secrets.npmToken(),
      secrets.sendGridKey(),
      secrets.entraClientSecret(),
    ];
    const result = redact(keys.map((key, i) => `key${i} -> ${key}.`).join('\n'));
    for (const key of keys) expect(result.text).not.toContain(key);
    expect(countOf(result, 'api_key')).toBe(keys.length);
  });

  it('redacts generic key assignments and preserves quoting', () => {
    const value = secrets.apiKeyValue();
    const result = redact(
      [
        `api_key=${value}`,
        `X-Api-Key: ${value}`,
        `{"apiKey": "${value}", "region": "eu"}`,
        `Ocp-Apim-Subscription-Key: ${value}`,
        `access_token = '${value}'`,
      ].join('\n'),
    );
    expect(result.text).toBe(
      [
        'api_key=[REDACTED:api_key]',
        'X-Api-Key: [REDACTED:api_key]',
        '{"apiKey": "[REDACTED:api_key]", "region": "eu"}',
        'Ocp-Apim-Subscription-Key: [REDACTED:api_key]',
        "access_token = '[REDACTED:api_key]'",
      ].join('\n'),
    );
  });

  it('does not mistake ordinary words, counters or variable references for keys', () => {
    const benign = [
      'token: expired',
      'max_tokens=4000',
      'promptTokens: 1234567',
      'api_key=${API_KEY}',
      'apiKey: <your-key-here>',
      'token=null',
      'sk-learn-compatible-estimator-name',
      'access_token=********',
      'Token validation failed for the user',
    ].join('\n');
    expect(redact(benign).text).toBe(benign);
  });

  it('redacts password assignments in several syntaxes', () => {
    const password = secrets.password();
    const result = redact(
      [
        `password=${password}`,
        `DB_PASSWORD="${password}"`,
        `{"password": "${password}", "user": "svc"}`,
        `passwd: ${password}`,
        `client_secret: ${secrets.apiKeyValue()}`,
        `https://login.contoso.example/?user=a&password=${password}&x=1`,
      ].join('\n'),
    );
    expect(result.text).toBe(
      [
        'password=[REDACTED:password_assignment]',
        'DB_PASSWORD="[REDACTED:password_assignment]"',
        '{"password": "[REDACTED:password_assignment]", "user": "svc"}',
        'passwd: [REDACTED:password_assignment]',
        'client_secret: [REDACTED:password_assignment]',
        'https://login.contoso.example/?user=a&password=[REDACTED:password_assignment]&x=1',
      ].join('\n'),
    );
  });

  it('keeps prose and stand-ins that follow the word password', () => {
    const benign = [
      'Password: must be at least 12 characters',
      'password: expired',
      'password=',
      'password: null',
      'passwordless sign-in is enabled',
      'secretary: Dana',
      'password: ********',
      'client_secret_basic is the auth method',
    ].join('\n');
    expect(redact(benign).text).toBe(benign);
  });

  it('redacts private key blocks of every flavour and truncated ones', () => {
    const labels = [
      'PRIVATE KEY',
      'RSA PRIVATE KEY',
      'EC PRIVATE KEY',
      'OPENSSH PRIVATE KEY',
      'ENCRYPTED PRIVATE KEY',
    ];
    for (const label of labels) {
      const pem = secrets.pem(label);
      const result = redact(`before\n${pem}\nafter`);
      expect(result.text, label).toBe('before\n[REDACTED:private_key]\nafter');
    }
    const truncated = secrets.pem('RSA PRIVATE KEY').split('\n').slice(0, 4).join('\n');
    const cut = redact(`log excerpt:\n${truncated}`);
    expect(cut.text).toBe('log excerpt:\n[REDACTED:private_key]');
    expect(cut.text).not.toContain(fixture(64, 'AB', 1)); // sanity: body lines are gone
  });

  it('keeps certificates and public keys, which are not secrets', () => {
    const cert = [
      '-----BEGIN CERTIFICATE-----',
      fixture(64, B62, 9),
      '-----END CERTIFICATE-----',
    ].join('\n');
    expect(redact(cert).text).toBe(cert);
  });

  it('redacts credentials inside connection strings and URLs but keeps the host for diagnosis', () => {
    const password = secrets.password();
    const accountKey = secrets.storageAccountKey();
    const result = redact(
      [
        `postgres://svc_user:${password}@db.contoso.example:5432/caseguard?sslmode=require`,
        `redis://:${password}@cache.contoso.example:6380`,
        `DefaultEndpointsProtocol=https;AccountName=contosodata;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
        `Server=tcp:sql.contoso.example,1433;User ID=sa;Password=${password};Encrypt=true`,
        `InstrumentationKey=00000000-0000-4000-8000-000000000001;IngestionEndpoint=https://eu.in.example/`,
        `SharedAccessSignature=sv=2022-11-02&sr=b&sig=${secrets.sasSignature()}`,
      ].join('\n'),
    );
    expect(result.text).toBe(
      [
        'postgres://[REDACTED:connection_string]@db.contoso.example:5432/caseguard?sslmode=require',
        'redis://[REDACTED:connection_string]@cache.contoso.example:6380',
        'DefaultEndpointsProtocol=https;AccountName=contosodata;AccountKey=[REDACTED:connection_string];EndpointSuffix=core.windows.net',
        'Server=tcp:sql.contoso.example,1433;User ID=sa;Password=[REDACTED:connection_string];Encrypt=true',
        'InstrumentationKey=[REDACTED:connection_string];IngestionEndpoint=https://eu.in.example/',
        'SharedAccessSignature=[REDACTED:connection_string]',
      ].join('\n'),
    );
    expect(countOf(result, 'connection_string')).toBe(6);
    expect(result.text).not.toContain(password);
    expect(result.text).not.toContain(accountKey);
  });

  it('classifies a lone Password= as a password and a delimited one as a connection string', () => {
    const password = secrets.password();
    expect(redact(`Password=${password}`).text).toBe('Password=[REDACTED:password_assignment]');
    expect(redact(`Data Source=x;Password=${password}`).text).toBe(
      'Data Source=x;Password=[REDACTED:connection_string]',
    );
  });

  it('redacts storage account keys and SAS signatures', () => {
    const key = secrets.storageAccountKey();
    const sig = secrets.sasSignature();
    const result = redact(
      `key ${key} and https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sp=r&sig=${sig}`,
    );
    expect(result.text).toBe(
      'key [REDACTED:azure_storage_key] and https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sp=r&sig=[REDACTED:azure_storage_key]',
    );
  });

  it('does not treat shorter or longer base64 runs as storage keys', () => {
    const notKey = concat(fixture(40, B62, 4), '==');
    expect(redact(`hash ${notKey}`).text).toBe(`hash ${notKey}`);
    const embedded = concat(fixture(100, B62, 5));
    expect(redact(embedded).text).toBe(embedded);
  });
});

describe('redactText: personal data and the synthetic-data exemption (FR-ING-04)', () => {
  it('pseudonymises e-mail addresses consistently within one state', () => {
    const result = redact(
      'Ava <ava@customer.io> wrote to Bo (bo@customer.io); Ava again: AVA@customer.io. cc ava@customer.io',
    );
    expect(result.text).toBe(
      'Ava <[REDACTED:email_address#1]> wrote to Bo ([REDACTED:email_address#2]); Ava again: [REDACTED:email_address#1]. cc [REDACTED:email_address#1]',
    );
    expect(result.findings).toEqual([
      { category: 'email_address', count: 4, placeholder: '[REDACTED:email_address]' },
    ]);
  });

  it('[FR-ING-04] leaves addresses on reserved test domains alone', () => {
    const synthetic = [
      'ava@contoso.invalid',
      'bo@mail.fabrikam.example',
      'cy@host.test',
      'di@box.localhost',
      'ed@example.com',
      'fi@Example.NET',
      'gu@mail.example.org',
    ].join(' ');
    expect(redact(synthetic).text).toBe(synthetic);
    expect(redact(synthetic).totalReplacements).toBe(0);
  });

  it('redacts reserved-domain values too when asked (operational diagnostics)', () => {
    const result = redact('ava@contoso.invalid and ed@example.com', { redactReservedValues: true });
    expect(result.text).toBe('[REDACTED:email_address#1] and [REDACTED:email_address#2]');
  });

  it('does not confuse look-alike domains with reserved ones', () => {
    for (const address of [
      'a@example.com.evil.io',
      'a@notexample.com',
      'a@test.com',
      'a@example.co',
    ]) {
      expect(redact(address).text, address).toBe('[REDACTED:email_address#1]');
    }
  });

  it('handles punctuation and odd but valid local parts', () => {
    const result = redact('mailto:first.last+tag_1%x@sub.customer.co.uk, (x-y@a-b.io). <z@q.de>;');
    expect(result.text).toBe(
      'mailto:[REDACTED:email_address#1], ([REDACTED:email_address#2]). <[REDACTED:email_address#3]>;',
    );
  });

  it('pseudonymises public IPv4 addresses', () => {
    const result = redact('client 8.8.8.8:53 and 1.1.1.1/32, again 8.8.8.8.');
    expect(result.text).toBe(
      'client [REDACTED:ipv4_address#1]:53 and [REDACTED:ipv4_address#2]/32, again [REDACTED:ipv4_address#1].',
    );
  });

  it('[FR-ING-04] leaves private, loopback, link-local and documentation IPv4 ranges alone', () => {
    const reserved = [
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.20',
      '127.0.0.1',
      '127.8.9.10',
      '169.254.169.254',
      '192.0.2.44',
      '198.51.100.7',
      '203.0.113.200',
    ].join(' ');
    expect(redact(`hosts: ${reserved}`).text).toBe(`hosts: ${reserved}`);
  });

  it('redacts addresses just outside the exempt ranges', () => {
    const outside = [
      '172.15.0.1',
      '172.32.0.1',
      '11.0.0.1',
      '192.169.1.1',
      '169.255.0.1',
      '192.0.3.1',
      '198.51.101.1',
      '203.0.114.1',
    ];
    const result = redact(outside.join(' '));
    expect(countOf(result, 'ipv4_address')).toBe(outside.length);
  });

  it('is strict about what counts as an address', () => {
    const benign = [
      'version 10.0.19045.3693',
      'build 1.2.3.4.5',
      'range 999.1.1.1 and 256.256.256.256',
      'sample 1.2.3',
      'item v1.2.3.4',
      'id x8.8.8.8',
    ].join('\n');
    expect(redact(benign).text).toBe(benign);
  });

  it('redacts public addresses when asked to redact reserved values as well', () => {
    const result = redact('10.0.0.1 127.0.0.1', { redactReservedValues: true });
    expect(result.text).toBe('[REDACTED:ipv4_address#1] [REDACTED:ipv4_address#2]');
  });

  it('pseudonymises phone numbers across formats with one number per person', () => {
    const result = redact(
      'call +1 (425) 555-0100 or 425-555-0100 or 425.555.0100; UK +44 20 7946 0958; IN +919876543210; again (425) 555 0100',
    );
    expect(result.text).toBe(
      'call [REDACTED:phone_number#1] or [REDACTED:phone_number#1] or [REDACTED:phone_number#1]; UK [REDACTED:phone_number#2]; IN [REDACTED:phone_number#3]; again [REDACTED:phone_number#1]',
    );
  });

  it('does not mistake dates, versions, ids or short numbers for phone numbers', () => {
    const benign = [
      '2025-01-31 12:30:45',
      'ticket 1234-5678-9012',
      'case 2501310012345',
      'build 16.0.5413.1000',
      'port 4000, size 1048576',
      'ip 192.168.100.200',
      'guid 3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      'total +5 items, +12 more',
    ].join('\n');
    expect(redact(benign).text).toBe(benign);
  });
});

describe('redactText: behaviour', () => {
  it('reports findings in canonical category order with exact counts', () => {
    const result = redact(
      [
        'ip 8.8.8.8',
        `mail a@customer.io b@customer.io`,
        `Bearer ${secrets.bearerToken()}`,
        `password=${secrets.password()}`,
      ].join('\n'),
    );
    const order = result.findings.map((finding) => finding.category);
    expect(order).toEqual(REDACTION_CATEGORIES.filter((category) => order.includes(category)));
    expect(order).toEqual(['bearer_token', 'password_assignment', 'email_address', 'ipv4_address']);
    expect(result.totalReplacements).toBe(1 + 1 + 2 + 1);
    for (const finding of result.findings) {
      expect(finding.count).toBeGreaterThanOrEqual(1);
      expect(finding.placeholder.length).toBeLessThanOrEqual(60);
    }
  });

  it('[NFR-PRIV-01] never leaks matched values through findings or notes', () => {
    const token = secrets.bearerToken(77);
    const email = 'private.person@customer.io';
    const result = redact(`Bearer ${token} ${email} password=${secrets.password(78)}`);
    const serialized = JSON.stringify([result.findings, result.notes]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('private.person');
    expect(serialized).not.toContain('customer.io');
  });

  it('honours enabledCategories exactly', () => {
    const text = `a@customer.io 8.8.8.8 Bearer ${secrets.bearerToken()}`;
    const onlyEmail = redact(text, { enabledCategories: ['email_address'] });
    expect(onlyEmail.text).toContain('8.8.8.8');
    expect(onlyEmail.text).toContain('Bearer ');
    expect(onlyEmail.text).toContain('[REDACTED:email_address#1]');
    expect(redact(text, { enabledCategories: [] }).text).toBe(text);
  });

  it('uses the governance defaults when no options are given', () => {
    expect(DEFAULT_REDACTION_OPTIONS.enabledCategories).not.toContain('custom');
    expect(DEFAULT_REDACTION_OPTIONS.enabledCategories).toContain('email_address');
    expect(DEFAULT_REDACTION_OPTIONS.redactReservedValues).toBe(false);
    expect(Object.isFrozen(DEFAULT_REDACTION_OPTIONS)).toBe(true);
  });

  it('[NFR-OBS-01] offers a credentials-only category set for logs that leaves addresses readable', () => {
    expect(SECRET_REDACTION_CATEGORIES).not.toContain('email_address');
    expect(SECRET_REDACTION_CATEGORIES).not.toContain('ipv4_address');
    expect(SECRET_REDACTION_CATEGORIES).not.toContain('phone_number');
    const text = `from 8.8.8.8 by a@customer.io Bearer ${secrets.bearerToken()} password=${secrets.password()}`;
    const scrubbed = redact(text, { enabledCategories: SECRET_REDACTION_CATEGORIES });
    expect(scrubbed.text).toBe(
      'from 8.8.8.8 by a@customer.io Bearer [REDACTED:bearer_token] password=[REDACTED:password_assignment]',
    );
    for (const category of DEFAULT_REDACTION_OPTIONS.enabledCategories.filter(
      (c) => !['email_address', 'ipv4_address', 'phone_number'].includes(c),
    )) {
      expect(SECRET_REDACTION_CATEGORIES).toContain(category);
    }
    expect(Object.isFrozen(SECRET_REDACTION_CATEGORIES)).toBe(true);
  });

  it('is idempotent and reports nothing on a second pass', () => {
    const text = [
      `Authorization: Bearer ${secrets.bearerToken()}`,
      `postgres://u:${secrets.password()}@db.contoso.example/x`,
      `Password=${secrets.password(8)} ${secrets.pem()}`,
      'a@customer.io b@customer.io 8.8.4.4 +1 425 555 0100',
      `${secrets.jwt()} ${secrets.githubToken()} ${secrets.storageAccountKey()}`,
    ].join('\n');
    const once = redact(text);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.totalReplacements).toBe(0);
  });

  it('keeps placeholders intact and never nests them', () => {
    const once = redact(`password=${secrets.password()} Bearer ${secrets.bearerToken()}`).text;
    expect(once).toBe('password=[REDACTED:password_assignment] Bearer [REDACTED:bearer_token]');
    expect(redact(`x ${once} y`, { redactReservedValues: true }).text).toBe(`x ${once} y`);
  });

  it('shares pseudonyms across calls that share a state and restarts for a new one', () => {
    const state = createPseudonymState();
    const first = redactText('a@customer.io', {}, state).text;
    const second = redactText('b@customer.io a@customer.io', {}, state).text;
    expect(first).toBe('[REDACTED:email_address#1]');
    expect(second).toBe('[REDACTED:email_address#2] [REDACTED:email_address#1]');
    expect(redactText('b@customer.io').text).toBe('[REDACTED:email_address#1]');
  });

  it('never reuses a pseudonym number already present in partially redacted input', () => {
    const state = createPseudonymState();
    const result = redactText('[REDACTED:email_address#2] and new@customer.io', {}, state);
    expect(result.text).toBe('[REDACTED:email_address#2] and [REDACTED:email_address#3]');
  });

  it('keeps counters per category independent', () => {
    const result = redact('a@customer.io 8.8.8.8 +1 425 555 0100 b@customer.io 1.1.1.1');
    expect(result.text).toBe(
      '[REDACTED:email_address#1] [REDACTED:ipv4_address#1] [REDACTED:phone_number#1] [REDACTED:email_address#2] [REDACTED:ipv4_address#2]',
    );
  });

  it('bounds memory when a state sees an unbounded number of distinct values', () => {
    const state = createPseudonymState();
    const category: PseudonymCategory = 'email_address';
    for (let i = 0; i < 50_000; i += 1) expect(state.indexFor(category, `k${i}`)).toBe(i + 1);
    expect(state.indexFor(category, 'one-too-many')).toBeNull();
    expect(state.indexFor(category, 'k0')).toBe(1); // known values keep their number
  });

  it('handles empty, whitespace-only and non-ASCII input', () => {
    expect(redact('').text).toBe('');
    expect(redact('   \n\t ').totalReplacements).toBe(0);
    const text = 'Привіт 你好 🌍 — a@customer.io ✓';
    expect(redact(text).text).toBe('Привіт 你好 🌍 — [REDACTED:email_address#1] ✓');
  });

  it('keeps line structure (every secret is replaced in place)', () => {
    const lines = ['one', `Bearer ${secrets.bearerToken()}`, 'three', 'a@customer.io', 'five'];
    const result = redact(lines.join('\n'));
    expect(result.text.split('\n')).toHaveLength(lines.length);
  });
});

describe('synthetic-data helpers', () => {
  it('classifies reserved e-mail domains', () => {
    expect(isReservedEmailDomain('contoso.invalid')).toBe(true);
    expect(isReservedEmailDomain('MAIL.EXAMPLE.ORG.')).toBe(true);
    expect(isReservedEmailDomain('example.com.attacker.io')).toBe(false);
    expect(isReservedEmailDomain('gmail.com')).toBe(false);
  });

  it('classifies non-routable IPv4 ranges', () => {
    expect(isNonRoutableIpv4([10, 1, 2, 3])).toBe(true);
    expect(isNonRoutableIpv4([172, 20, 0, 1])).toBe(true);
    expect(isNonRoutableIpv4([8, 8, 8, 8])).toBe(false);
    expect(isNonRoutableIpv4([])).toBe(false);
  });
});
