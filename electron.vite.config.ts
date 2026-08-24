import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * IMPORTANT — `package.json` deliberately has NO `"type": "module"`.
 *
 * With `type: module`, electron-vite emits the preload as ESM (`index.mjs`).
 * Electron's default `sandbox: true` cannot load an ESM preload: it fails with
 * "Cannot use import statement outside a module", `window.botApp` is silently
 * `undefined`, and there is no build error. We keep main + preload on CJS and
 * pin the preload output format below so a future `type: module` cannot
 * reintroduce that failure.
 *
 * Consequence for main/preload source: no top-level `await` and no
 * `import.meta.url` (use `__dirname`). ESM import/export syntax is fine — it is
 * compiled away.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        // Native .node addons can never be bundled.
        external: ['better-sqlite3'],
        input: {
          index: resolve('src/main/index.ts'),
          // Standalone stdio MCP server spawned by Claude Code for bot-to-bot
          // handoffs. Must stay dependency-free (node: builtins only).
          'mcp-bridge': resolve('src/main/mcp/bridge.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },

  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CJS + .cjs extension: works under sandbox true *and* false.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },

  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
