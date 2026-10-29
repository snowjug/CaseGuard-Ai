import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const apiRoot = fileURLToPath(new URL('.', import.meta.url));
const migrationsSource = join(apiRoot, 'src', 'db', 'migrations');
const distRoot = join(apiRoot, 'dist');
// The migration runner resolves its SQL files relative to the compiled output.
const migrationsTarget = join(distRoot, 'db', 'migrations');
const bundles = [join(distRoot, 'main.js'), join(distRoot, 'db', 'migrate-cli.js')];

/** Names listed under `dependencies` in apps/api/package.json: what `pnpm deploy --prod` ships. */
async function declaredDependencies(): Promise<Set<string>> {
  const manifest: unknown = JSON.parse(await readFile(join(apiRoot, 'package.json'), 'utf8'));
  const dependencies =
    typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest
      ? manifest.dependencies
      : undefined;
  if (typeof dependencies !== 'object' || dependencies === null) {
    throw new Error('apps/api/package.json has no "dependencies" object');
  }
  return new Set(Object.keys(dependencies));
}

/** Copies the SQL migrations next to the bundle; an image without migrations cannot start. */
async function copyMigrations(): Promise<number> {
  if (!existsSync(migrationsSource)) {
    throw new Error(`migrations directory not found: ${migrationsSource}`);
  }
  const files = (await readdir(migrationsSource)).filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) {
    throw new Error(`no .sql migrations found in ${migrationsSource}`);
  }
  await rm(migrationsTarget, { recursive: true, force: true });
  await mkdir(migrationsTarget, { recursive: true });
  for (const file of files) {
    await cp(join(migrationsSource, file), join(migrationsTarget, file));
  }
  return files.length;
}

const STATIC_IMPORT = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_CALL = /\b(?:__require|require)\(\s*["']([^"']+)["']\s*\)/g;

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * Fails the build when a bundle imports an npm package that is not a production dependency of
 * @caseguard/api. `pnpm deploy --prod` only links declared dependencies at the top level of
 * node_modules, so an undeclared import would crash the container at start-up instead of here.
 */
async function assertExternalsAreDeclared(): Promise<void> {
  const declared = await declaredDependencies();
  const offenders = new Map<string, Set<string>>();
  for (const bundle of bundles) {
    if (!existsSync(bundle)) throw new Error(`expected bundle was not produced: ${bundle}`);
    const code = await readFile(bundle, 'utf8');
    for (const pattern of [STATIC_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) continue;
        if (isBuiltin(specifier) || specifier.startsWith('node:')) continue;
        const name = packageName(specifier);
        if (declared.has(name)) continue;
        const importers = offenders.get(name) ?? new Set<string>();
        importers.add(bundle.slice(distRoot.length + 1));
        offenders.set(name, importers);
      }
    }
  }
  if (offenders.size > 0) {
    const lines = [...offenders].map(
      ([name, from]) => `  ${name} (imported by ${[...from].join(', ')})`,
    );
    throw new Error(
      `bundle imports packages that are not dependencies of @caseguard/api:\n${lines.join('\n')}\n` +
        'Declare them in apps/api/package.json "dependencies" so `pnpm deploy --prod` ships them.',
    );
  }
}

export default defineConfig({
  entry: { main: 'src/main.ts', 'db/migrate-cli': 'src/db/migrate-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  keepNames: true,
  // Workspace packages export TypeScript sources (just-in-time packages), so they are compiled into
  // the bundle. npm dependencies stay external and are resolved from the deployed node_modules.
  noExternal: [/^@caseguard\//],
  // PGlite loads its WASM and data files relative to its own module URL; bundling would break that.
  external: ['@electric-sql/pglite'],
  async onSuccess() {
    const count = await copyMigrations();
    await assertExternalsAreDeclared();
    console.log(`copied ${count} SQL migration(s) to dist/db/migrations`);
  },
});
