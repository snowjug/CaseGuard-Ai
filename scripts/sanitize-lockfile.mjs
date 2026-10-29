#!/usr/bin/env node
// Removes registry-specific `tarball:` URLs from pnpm-lock.yaml.
//
// Some corporate package feeds return tarball URLs on private hosts, which pnpm then records in the
// lockfile. Committing those would break installs for everyone outside that network. Integrity
// hashes are kept, so every download is still verified against the committed lockfile.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lockPath = resolve(process.cwd(), 'pnpm-lock.yaml');
const original = readFileSync(lockPath, 'utf8');
const sanitized = original.replace(/, tarball: https?:\/\/[^}\s]+/g, '');

if (sanitized !== original) {
  writeFileSync(lockPath, sanitized);
  const removed = (original.match(/, tarball: https?:\/\//g) ?? []).length;
  console.log(`sanitize-lockfile: removed ${removed} tarball URL(s) from pnpm-lock.yaml`);
} else {
  console.log('sanitize-lockfile: lockfile already clean');
}

const leftovers = /visualstudio\.com|packagefeedproxy|pkgs\.dev\.azure\.com/.exec(sanitized);
if (leftovers) {
  console.error(`sanitize-lockfile: private feed reference remains in lockfile: ${leftovers[0]}`);
  process.exit(1);
}
