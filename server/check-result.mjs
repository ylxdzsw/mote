import fs from 'node:fs/promises'
import path from 'node:path'
import { loadCandidate } from './moted.mjs'

const output = process.argv[2] || process.env.MOTED_OUTPUT_DIR
const input = process.env.MOTED_INPUT_DIR
if (!output || !input) throw new Error('Usage: MOTED_INPUT_DIR=... node server/check-result.mjs OUTPUT_DIRECTORY')
const document = JSON.parse(await fs.readFile(path.join(input, 'document.json'), 'utf8'))
const target = JSON.parse(await fs.readFile(path.join(input, 'target.json'), 'utf8'))
await loadCandidate(path.resolve(output), document, target)
console.log('Candidate validated for delivery.')
