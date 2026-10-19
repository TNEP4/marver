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
})
