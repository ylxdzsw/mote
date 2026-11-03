import { publishDocument } from '../../shared/document.mjs'
import type { MoteDocument } from '../document/model'
import { highlightCode, loadCodeLanguage } from '../editor/codeLanguages'

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
    '<': '\\u003c',
    '>': '\\u003e',
    '&': '\\u0026',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  })[character] ?? character)
}

function safeInline(value: string, tag: 'script' | 'style') {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

export async function exportHtml(doc: MoteDocument): Promise<Blob> {
  const published = publishDocument(doc)
  const [{ default: bundle }, highlights] = await Promise.all([
    import('virtual:mote-reader-bundle').catch(() => {
      throw new Error('The HTML reader could not load. Reconnect and try again; your document is unchanged.')
    }),
    Promise.all(published.objects.filter(object => object.kind === 'code').map(async object => [
      `code:${object.id}`, highlightCode(object.source, object.source ? await loadCodeLanguage(object.language) : null),
    ])).then(Object.fromEntries).catch(() => {
      throw new Error('Code highlighting could not load. Reconnect and try again; your document is unchanged.')
    }),
  ])
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mote</title>
<style>${safeInline(bundle.css, 'style')}</style>
</head>
<body>
<div id="root"></div>
<noscript>This Mote reader needs JavaScript to display its document.</noscript>
<script type="application/json" id="mote-document">${safeJson(published)}</script>
<script type="application/json" id="mote-code-highlights-v1">${safeJson(highlights)}</script>
<script>${safeInline(bundle.js, 'script')}</script>
</body>
</html>`
  return new Blob([html], { type: 'text/html' })
}
