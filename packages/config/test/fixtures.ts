export const ENTRA_TENANT = '11111111-2222-3333-4444-555555555555';
export const ENTRA_API = '66666666-7777-8888-9999-000000000000';

/** A complete, valid production environment; tests override single variables. */
export const PRODUCTION_ENV: Record<string, string> = {
  APP_ENV: 'production',
  AUTH_MODE: 'entra',
  DEV_AUTH_ENABLED: 'false',
  ENTRA_TENANT_ID: ENTRA_TENANT,
  ENTRA_AUDIENCE: `api://${ENTRA_API}`,
  ENTRA_TENANT_MAP: JSON.stringify({ [ENTRA_TENANT]: 'tenant_contoso_support' }),
  CORS_ALLOWED_ORIGINS: 'https://caseguard.example.test',
  DATABASE_URL: 'postgres://caseguard_app@db.example.test:5432/caseguard?sslmode=require',
  DATABASE_AUTH: 'entra',
  STORAGE_PROVIDER: 'azure-blob',
  AZURE_STORAGE_ACCOUNT: 'stcaseguardprod',
  DEMO_MODE: 'false',
  DEMO_AUTO_SEED: 'false',
};
