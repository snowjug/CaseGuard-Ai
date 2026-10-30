import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Pins the two functions startTelemetry calls to the installed @azure/monitor-opentelemetry, so an upgrade
 * that renames or drops them fails here instead of at the first deployment. The test reads the package's
 * entry file instead of importing it: loading the distro pulls in the whole OpenTelemetry SDK (tens of
 * seconds on a slow disk) and nothing here needs it to run. The types are checked at compile time, because
 * startTelemetry's default loader is typed as returning an AzureMonitorDistro.
 */
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@azure/monitor-opentelemetry/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  version: string;
  exports: { '.': { import: { default: string } } };
};
const entry = readFileSync(
  join(dirname(manifestPath), manifest.exports['.'].import.default),
  'utf8',
);

describe('the installed @azure/monitor-opentelemetry', () => {
  it('[NFR-OBS-02] is a 1.x release, the line the distro options and the documentation were written against', () => {
    expect(manifest.version).toMatch(/^1\.\d+\.\d+$/);
  });

  it('[NFR-OBS-02] exports useAzureMonitor and shutdownAzureMonitor from its ESM entry', () => {
    expect(entry).toMatch(/export function useAzureMonitor\(/);
    expect(entry).toMatch(/export function shutdownAzureMonitor\(/);
  });
});
