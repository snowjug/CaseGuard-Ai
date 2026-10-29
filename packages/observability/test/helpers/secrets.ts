/**
 * Obviously fake credentials in realistic shapes. They are assembled at run time so no literal
 * secret-shaped string sits in the source (the repository secret scanner stays quiet) and every value
 * contains the word "fake" so it can never be mistaken for a real credential.
 */
export interface FakeSecret {
  readonly id: string;
  /** A realistic piece of text that embeds the secret. */
  readonly text: string;
  /** Substrings that must never appear in any log output or scrubbed text. */
  readonly cores: readonly string[];
}

const base64Url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export function fakeJwt(): { jwt: string; header: string; payload: string; signature: string } {
  const header = base64Url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64Url({ sub: 'user_fake_subject', tid: 'tenant_fake', fake: true });
  const signature = Buffer.from('fake-signature-not-a-real-one').toString('base64url');
  return { jwt: [header, payload, signature].join('.'), header, payload, signature };
}

export function fakeSecrets(): FakeSecret[] {
  const { jwt, payload, signature } = fakeJwt();
  const bearer = 'fakeBearerToken0123456789abcdef';
  const sqlPassword = 'Fake-Pa55w0rd-9x';
  const pgPassword = 'fakeP4ssw0rdXyz';
  const sasSignature = 'ZmFrZVNpZ25hdHVyZVZhbHVl%2Bfake%3D';
  const accountKey = Buffer.from('fake-account-key-material-0123456789abcdef'.repeat(2)).toString(
    'base64',
  );
  const apiKey = 'fake-api-key-0123456789abcdef';
  const github = ['ghp', '_', 'fake'.repeat(9)].join('');
  const aws = ['AKIA', 'FAKE'.repeat(4)].join('');
  const openAi = ['sk', '-', 'fakefakefakefakefakefake01'].join('');
  const slack = ['xoxb', '-', '1234567890-fakefakefake'].join('');
  const entra = ['fak8Q', '~', 'fakefakefakefakefakefakefakefak'].join('');
  const cookie = 'fakeSessionCookie0123456789';
  const email = 'fake.person@example.test';
  const pemBody = 'MIIFAKEKEYBODYfakefakefakefakefakefakefakefakefake0123456789';
  const pem = [
    ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
    pemBody,
    `${pemBody}ZZ`,
    ['-----END', 'RSA PRIVATE KEY-----'].join(' '),
  ].join('\n');
  const password = 'fakeHunter2Value';

  return [
    { id: 'bearer-opaque', text: `Authorization: Bearer ${bearer}`, cores: [bearer] },
    { id: 'bearer-lowercase-scheme', text: `header bearer ${bearer}x was sent`, cores: [bearer] },
    { id: 'jwt', text: `Bearer ${jwt}`, cores: [jwt, payload, signature] },
    { id: 'jwt-bare', text: `rejected token ${jwt} for caller`, cores: [jwt, payload, signature] },
    {
      id: 'sql-connection-string',
      text: `Server=tcp:fake-db.example.test,1433;Database=cg;User Id=svc_fake;Password=${sqlPassword};Encrypt=true`,
      cores: [sqlPassword],
    },
    {
      id: 'postgres-url',
      text: `postgres://app_fake:${pgPassword}@db.example.test:5432/cg?sslmode=require`,
      cores: [pgPassword],
    },
    {
      id: 'sas-url',
      text: `https://fakeacct.blob.core.windows.net/cases/bundle.json?sv=2022-11-02&ss=b&sp=r&se=2030-01-01T00%3A00%3A00Z&sig=${sasSignature}`,
      cores: [sasSignature],
    },
    {
      id: 'storage-account-key',
      text: `DefaultEndpointsProtocol=https;AccountName=fakeacct;AccountKey=${accountKey};EndpointSuffix=core.windows.net`,
      cores: [accountKey, accountKey.slice(0, 40)],
    },
    { id: 'api-key-header', text: `x-api-key: ${apiKey}`, cores: [apiKey] },
    { id: 'api-key-assignment', text: `AZURE_OPENAI_API_KEY=${apiKey}`, cores: [apiKey] },
    { id: 'github-token', text: `cloning with ${github}`, cores: [github] },
    { id: 'aws-access-key-id', text: `credentials ${aws} loaded`, cores: [aws] },
    { id: 'openai-style-key', text: `key ${openAi} rejected`, cores: [openAi] },
    { id: 'slack-token', text: `posting with ${slack}`, cores: [slack] },
    { id: 'entra-client-secret', text: `secret shape ${entra} leaked`, cores: [entra] },
    { id: 'cookie-header', text: `Cookie: session=${cookie}; theme=dark`, cores: [cookie] },
    {
      id: 'set-cookie-header',
      text: `Set-Cookie: sid=${cookie}; HttpOnly; Secure`,
      cores: [cookie],
    },
    {
      id: 'password-assignment',
      text: `login failed password=${password} for user`,
      cores: [password],
    },
    {
      id: 'json-password',
      text: `{"user":"svc_fake","password":"${password}","ok":true}`,
      cores: [password],
    },
    { id: 'private-key-pem', text: `loaded key\n${pem}\ndone`, cores: [pemBody] },
    { id: 'email-address', text: `notify ${email} about it`, cores: [email] },
  ];
}
