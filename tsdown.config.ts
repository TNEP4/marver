import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  external: ['vite', '@vitejs/plugin-react', 'cac'],
})
