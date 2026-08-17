import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  // playwright-core is required lazily by the M7 compiler at dev/publish time only. Keep it EXTERNAL:
  // it self-bundles chromium-bidi via deep CJS requires + uses eval, which the bundler can neither
  // resolve nor safely inline. It resolves from node_modules at runtime (a real dependency).
  external: ['vite', '@vitejs/plugin-react', 'cac', 'playwright-core'],
})
