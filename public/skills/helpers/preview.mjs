import { readFile, writeFile } from 'node:fs/promises'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('Usage: node server/preview.mjs candidate.html harness.html')
const template = await readFile(new URL('./preview-harness.html', import.meta.url), 'utf8')
const source = JSON.stringify(await readFile(input, 'utf8')).replaceAll('<', '\\u003c')
await writeFile(output, template.replace('__MOTE_CANDIDATE_HTML__', () => source))
