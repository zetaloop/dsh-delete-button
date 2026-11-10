import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  packages: 'external',
})
await build({
  entryPoints: ['src/client.tsx'],
  outfile: 'dist/client.js',
  platform: 'browser',
  format: 'cjs',
  bundle: true,
  jsx: 'automatic',
  external: [
    'react',
    'react-dom',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-store',
    'zod',
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})
