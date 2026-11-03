import { createContext, useContext, type ComponentProps } from 'react'
import type { CodeToken } from '../document/code'
import type { SourceEditor as Editor } from '../editor/SourceEditor'
import { SourceDisplay } from '../editor/SourceDisplay'

export const CodeHighlights = createContext<Record<string, CodeToken[]>>({})

// The standalone build substitutes this adapter for SourceEditor. Its display
// stays shared, but neither CodeMirror nor language parsers enter that bundle.
export function SourceEditor({ source, editorId }: ComponentProps<typeof Editor>) {
  const tokens = useContext(CodeHighlights)[editorId] ?? [{ text: source }]
  return <div className="code-source"><SourceDisplay tokens={tokens} /></div>
}
