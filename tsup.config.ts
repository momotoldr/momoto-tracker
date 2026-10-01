import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

// Three entry points, one per subpath export. `react` is external (a peer dependency),
// and nothing else is imported at runtime, so each bundle is only this library's code.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'plugins/index': 'src/plugins/index.ts',
    'react/index': 'src/react/index.ts',
  },
  format: ['esm'],
  target: 'es2020',
  dts: true,
  clean: true,
  treeshake: true,
  // Shared modules (types, uuid) go to a chunk rather than being duplicated per entry.
  splitting: true,
  external: ['react'],
  define: { __SDK_VERSION__: JSON.stringify(version) },
})
