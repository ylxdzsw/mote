import { build, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = decodeURIComponent(new URL('.', import.meta.url).pathname)
const readerEntry = `${projectRoot}src/reader/main.tsx`
const readerVirtualId = '\0virtual:mote-reader-bundle'

interface ReaderBundle {
  js: string
  css: string
  fonts: string[]
}

function readerBundlePlugin(): Plugin {
  let pending: Promise<ReaderBundle> | undefined
  const invalidate = () => { pending = undefined }
  const bundle = async (): Promise<ReaderBundle> => {
    const fonts: string[] = []
    const result = await build({
      configFile: false,
      mode: 'production',
      root: projectRoot,
      plugins: [react(), {
        name: 'mote-reader-fonts',
        enforce: 'pre',
        async resolveId(source, importer) {
          if (!source.endsWith('.woff2?url&inline')) return
          const resolved = await this.resolve(source, importer, { skipSelf: true })
          if (!resolved) throw new Error(`Could not resolve reader font: ${source}`)
          if (!fonts.includes(resolved.id)) fonts.push(resolved.id)
          return { id: resolved.id, external: true }
        },
        buildEnd() { fonts.sort() },
      }],
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      oxc: { jsx: { development: false } },
      build: {
        write: false,
        lib: { entry: readerEntry, name: 'MoteReader', formats: ['iife'], fileName: 'mote-reader' },
        cssCodeSplit: false,
        assetsInlineLimit: Infinity,
        rolldownOptions: {
          output: { globals: id => `moteReaderFont${fonts.indexOf(id)}` },
        },
      },
    })
    const output = Array.isArray(result) ? result.flatMap(item => item.output)
      : 'output' in result ? result.output : []
    const javascript = output.find(item => item.type === 'chunk')
    const stylesheet = output.find(item => item.type === 'asset' && item.fileName.endsWith('.css'))
    if (!javascript || javascript.type !== 'chunk') throw new Error('Mote reader bundle did not produce JavaScript')
    return { js: javascript.code, css: stylesheet?.type === 'asset' ? String(stylesheet.source) : '', fonts }
  }
  return {
    name: 'mote-reader-bundle',
    resolveId(id) { return id === 'virtual:mote-reader-bundle' ? readerVirtualId : undefined },
    async load(id) {
      if (id !== readerVirtualId) return undefined
      pending ??= bundle().catch(error => { pending = undefined; throw error })
      const { js, css, fonts } = await pending
      // Reuse the app's inline font modules instead of embedding a second copy.
      // Reconstitute the complete IIFE in memory; exporting never fetches assets.
      const imports = fonts.map((font, index) => `import font${index} from ${JSON.stringify(font)}`).join('\n')
      const declarations = fonts.map((_, index) => `${JSON.stringify(`const moteReaderFont${index}=`)} + JSON.stringify(font${index}) + ';'`).join(' + ')
      return `${imports}\nexport default { css: ${JSON.stringify(css)}, js: '(() => {' + ${declarations} + ${JSON.stringify(js)} + '})()' }`
    },
    handleHotUpdate(context) {
      if (!['src/', 'shared/'].some(directory => context.file.startsWith(`${projectRoot}${directory}`))) return
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
  server: { headers: { 'Cache-Control': 'no-store' }, proxy: { '/api': 'http://127.0.0.1:5174', '/a/': 'http://127.0.0.1:5174' } },
  preview: { headers: { 'Cache-Control': 'no-store' }, proxy: { '/api': 'http://127.0.0.1:5174', '/a/': 'http://127.0.0.1:5174' } },
})
