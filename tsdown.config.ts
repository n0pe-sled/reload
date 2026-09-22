/**
 * tsdown config for dsh-reload: the node-half library build plus the browser
 * client bundle.
 *
 * The browser half replicates the client-bundle contract from
 * packages/client/tsdown.client.ts (clientConfig): a lazy CJS factory artifact
 * served from lib/client.js, wrapped in the window.__ModuleLoader__.load
 * handoff, with the platform baseline (PLATFORM_MODULES +
 * PRELOADED_CLIENT_EXTERNALS from packages/client/web/src/platform.ts) kept
 * external so those specifiers materialize through the loader module table
 * instead of being duplicated into this bundle. clean stays off on both halves
 * so neither build wipes the other's output.
 */
import { isBuiltin } from 'node:module'

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const PRELOADED_CLIENT_EXTERNALS = [
  '@deepseek-ai/dsh-client-runtime/client',
] as const

const CLIENT_EXTERNALS = new Set<string>([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
])

/** Production sections of this package: the peer deps, subpaths included. */
const PRODUCTION_DEPENDENCIES = Object.keys({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-commands': '0.1.1-rc.2',
}).map(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`))

const matchesProduction = (specifier: string): boolean =>
  PRODUCTION_DEPENDENCIES.some(pattern => pattern.test(specifier))

export default [
  // Node half: plain ESM build of src/index.ts → lib/index.js, all production
  // deps external (resolved at runtime through the profile's node_modules
  // fallback). dts emits lib/index.d.ts for the types field.
  {
    name: 'dsh-reload',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => isBuiltin(specifier) || matchesProduction(specifier),
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !matchesProduction(specifier),
    },
  },
  // Browser half: lazy CJS factory bundle, served from lib/client.js.
  {
    name: 'dsh-reload/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // Types ship via the node-half dts; dts here would wrap the
    // banner/footer into .d.cts and break parsing.
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: 'dsh-reload', factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
