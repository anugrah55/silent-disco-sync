// Bundle the server (and the TypeScript-source @sds/shared workspace) into one ESM file.
// Real npm dependencies stay external and load from node_modules at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const shared = JSON.parse(readFileSync(new URL('../shared/package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(shared.dependencies ?? {})],
  logLevel: 'info',
});
