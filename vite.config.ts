import { build, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = decodeURIComponent(new URL('.', import.meta.url).pathname)
const readerEntry = `${projectRoot}src/reader/main.tsx`
const readerVirtualId = '\0virtual:mote-reader-bundle'

interface ReaderBundle {
  js: string
  css: string
}

function readerBundlePlugin(): Plugin {
  let pending: Promise<ReaderBundle> | undefined
  const invalidate = () => { pending = undefined }
  const bundle = async (): Promise<ReaderBundle> => {
    const result = await build({
      configFile: false,
      mode: 'production',
      root: projectRoot,
      plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      oxc: { jsx: { development: false } },
      build: {
        write: false,
        lib: { entry: readerEntry, name: 'MoteReader', formats: ['iife'], fileName: 'mote-reader' },
        cssCodeSplit: false,
        assetsInlineLimit: Infinity,
      },
    })
    const output = Array.isArray(result) ? result.flatMap(item => item.output)
      : 'output' in result ? result.output : []
    const javascript = output.find(item => item.type === 'chunk')
    const stylesheet = output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    if (!javascript || javascript.type !== 'chunk') throw new Error('Mote reader bundle did not produce JavaScript')
    return { js: javascript.code, css: stylesheet?.type === 'asset' ? String(stylesheet.source) : '' }
  }
  return {
    name: 'mote-reader-bundle',
    resolveId(id) { return id === 'virtual:mote-reader-bundle' ? readerVirtualId : undefined },
    async load(id) {
      if (id !== readerVirtualId) return undefined
      pending ??= bundle().catch(error => { pending = undefined; throw error })
      return `export default ${JSON.stringify(await pending)}`
    },
    handleHotUpdate(context) {
      if (!context.file.startsWith(`${projectRoot}src/`)) return
      invalidate()
      const module = context.server.moduleGraph.getModuleById(readerVirtualId)
      if (module) {
        context.server.moduleGraph.invalidateModule(module)
        return [...context.modules, module]
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), readerBundlePlugin()],
  server: { headers: { 'Cache-Control': 'no-store' } },
  preview: { headers: { 'Cache-Control': 'no-store' } },
})
