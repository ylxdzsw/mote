import path from 'node:path'
import { localDelivery } from './submit.mjs'
import { validateProposalDelivery } from './agent-protocol.mjs'

const output = process.argv[2] || process.env.MOTED_OUTPUT_DIR
if (!output) throw new Error('Usage: node server/check-result.mjs OUTPUT_DIRECTORY')
const { candidate, assets } = await localDelivery(path.resolve(output))
validateProposalDelivery(candidate, assets)
console.log('Proposal satisfies the current payload schema. Browser Accept checks reservation compatibility.')
