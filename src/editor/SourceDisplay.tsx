import { useMemo, type ReactNode } from 'react'
import type { CodeToken } from '../document/code'
import '../canvas/code.css'

function rowsFor(tokens: CodeToken[]): CodeToken[][] {
  const rows: CodeToken[][] = [[]]
  for (const token of tokens) {
    let start = 0
    while (start < token.text.length) {
      const newline = token.text.indexOf('\n', start)
      const end = newline < 0 ? token.text.length : newline
      if (end > start) rows.at(-1)!.push({ text: token.text.slice(start, end), kind: token.kind })
      if (newline < 0) break
      rows.push([])
      start = newline + 1
    }
  }
  return rows
}

export function SourceDisplay({ tokens, activeLine = 1, canEdit = false, children }: {
  tokens: CodeToken[]; activeLine?: number; canEdit?: boolean; children?: ReactNode
}) {
  const lines = useMemo(() => rowsFor(tokens), [tokens])
  return <div className="code-body">
    <div className="code-gutter" aria-hidden="true">{lines.map((_, index) => <span className={`code-line-number${index + 1 === activeLine ? ' is-active' : ''}`} key={index}>{index + 1}</span>)}</div>
    <div className="code-source-scroll" onPointerDown={event => { if (canEdit) event.stopPropagation() }}>
      <div className="code-source-track">
        <pre className="code-readonly" aria-hidden={canEdit || undefined}><code>{lines.map((line, index) => <span className="code-line" key={index}>{line.map((token, tokenIndex) => token.kind
          ? <span className={`code-token code-${token.kind}`} key={tokenIndex}>{token.text}</span>
          : <span key={tokenIndex}>{token.text}</span>)}{index < lines.length - 1 ? '\n' : null}</span>)}</code></pre>
        {children}
      </div>
    </div>
  </div>
}
