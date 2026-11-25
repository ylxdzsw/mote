import { build, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = decodeURIComponent(new URL('.', import.meta.url).pathname)
const previewEntry = `${projectRoot}src/ai/MarkupPreview.tsx`

function agentPreviewPlugin(): Plugin {
  return {
    name: 'mote-agent-preview',
    async generateBundle() {
      const result = await build({
        configFile: false,
        mode: 'production',
        root: projectRoot,
        plugins: [react()],
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        oxc: { jsx: { development: false } },
        build: {
          write: false,
          lib: { entry: previewEntry, name: 'MoteDocumentPreview', formats: ['iife'], fileName: () => 'document-preview.js', cssFileName: 'document-preview' },
          cssCodeSplit: false,
          rolldownOptions: { output: { codeSplitting: false } },
        },
      })
      const output = Array.isArray(result) ? result.flatMap(item => item.output) : 'output' in result ? result.output : []
      for (const item of output) {
        this.emitFile({ type: 'asset', fileName: `skills/helpers/${item.fileName}`, source: item.type === 'chunk' ? item.code : item.source })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), agentPreviewPlugin()],
  server: { headers: { 'Cache-Control': 'no-store' }, proxy: { '/api': 'http://127.0.0.1:5174', '/a/': 'http://127.0.0.1:5174' } },
  preview: { headers: { 'Cache-Control': 'no-store' }, proxy: { '/api': 'http://127.0.0.1:5174', '/a/': 'http://127.0.0.1:5174' } },
})
