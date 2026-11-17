import { readFile, writeFile } from 'node:fs/promises'

const nativePreviewTemplate = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mote reservation markup preview</title>
<style>__MOTE_PREVIEW_CSS__</style>
<style>
html,body,#root{height:auto;min-height:100%;overflow:visible}
body{min-height:100vh;background:#eee}
.app.local-markup-preview{height:auto;min-height:100vh;overflow:visible}
.local-markup-preview>.workspace{height:auto;min-height:100vh;overflow:visible}
</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="mote-document">__MOTE_DOCUMENT__</script>
<script type="application/json" id="mote-target">__MOTE_TARGET__</script>
<script type="application/json" id="mote-markup">__MOTE_MARKUP__</script>
<script>__MOTE_PREVIEW_JS__</script>
</body>
</html>`

const args = process.argv.slice(2)

if (args.length === 2) {
  const [input, output] = args
  const template = await readFile(new URL('./preview-harness.html', import.meta.url), 'utf8')
  const source = JSON.stringify(await readFile(input, 'utf8')).replaceAll('<', '\\u003c')
  await writeFile(output, template.replace('__MOTE_CANDIDATE_HTML__', () => source))
} else if (args.length === 3) {
  const [taskPath, documentPath, output] = args
  const task = JSON.parse(await readFile(taskPath, 'utf8'))
  const suppliedDocument = JSON.parse(await readFile(documentPath, 'utf8'))
  const document = suppliedDocument?.format === 'mote' ? suppliedDocument : suppliedDocument?.document ?? suppliedDocument
  const [javascript, stylesheet] = await Promise.all([readRuntime('document-preview.js'), readRuntime('document-preview.css')])
  const replacements = {
    __MOTE_DOCUMENT__: safeJSON(document),
    __MOTE_TARGET__: safeJSON(task?.target ?? null),
    __MOTE_MARKUP__: safeJSON(task?.markup ?? null),
    __MOTE_PREVIEW_CSS__: inline(stylesheet, 'style'),
    __MOTE_PREVIEW_JS__: inline(javascript, 'script'),
  }
  await writeFile(output, nativePreviewTemplate.replace(/__MOTE_[A-Z_]+__/g, token => replacements[token]))
} else {
  throw new Error('Usage: node preview.mjs candidate.html harness.html\n   or: node preview.mjs task.json document.json output.html')
}

async function readRuntime(name) {
  const locations = ['./', '../dist/skills/helpers/', '../../../dist/skills/helpers/']
  for (const location of locations) {
    try { return await readFile(new URL(`${location}${name}`, import.meta.url), 'utf8') }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
  throw new Error(`Missing ${name}. Build the preview runtime or keep its emitted files beside this helper.`)
}

function safeJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
  })[character])
}

function inline(value, tag) {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}
