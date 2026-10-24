import { defineConfig } from 'tsdown'

export default defineConfig({
  // the speech worker runs in its own thread: its own file beside the CLI (jam/audio.ts loads it)
  entry: { cli: 'src/cli/index.ts', 'speech-worker': 'src/server/jam/speech-worker.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  external: ['vite', '@vitejs/plugin-react', 'cac', 'ws', 'sherpa-onnx-node'],
  // the suite's seams (src/server/test-build.ts) are built in only for the suite: test/global-setup.ts sets
  // MV_TEST_BUILD=1; the npm build - the one CI publishes, after the suite - carries none
  define: { __MV_TEST__: JSON.stringify(process.env.MV_TEST_BUILD === '1') },
})
