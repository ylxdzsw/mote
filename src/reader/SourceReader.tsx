import { useContext, type ComponentProps } from 'react'
import type { SourceEditor as Editor } from '../editor/SourceEditor'
import { SourceDisplay } from '../editor/SourceDisplay'
import { PreparedContentContext } from './PreparedContent'

// The standalone build substitutes this adapter for SourceEditor. Its display
// stays shared, but neither CodeMirror nor language parsers enter that bundle.
export function SourceEditor({ source, editorId }: ComponentProps<typeof Editor>) {
  const tokens = useContext(PreparedContentContext).code[editorId] ?? [{ text: source }]
  return <div className="code-source"><SourceDisplay tokens={tokens} /></div>
}
