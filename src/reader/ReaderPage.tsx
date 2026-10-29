import { useMemo, type ReactNode } from 'react'
import { publishDocument } from '../../shared/document.mjs'
import { useMedia } from '../app/useMedia'
import { ReadDocument } from '../canvas/ReadDocument'
import type { MoteDocument } from '../document/model'
import { uiThemeVariables } from '../theme/ui'

// Only the source differs: authenticated working copy, public share, or embedded HTML.
export function ReaderPage({ initial, notice }: { initial: MoteDocument; notice?: ReactNode }) {
  const smallScreen = useMedia('(max-width: 1050px)')
  const published = useMemo(() => publishDocument(initial), [initial])
  const style = useMemo(() => uiThemeVariables(initial.theme, initial.language ?? 'en'), [initial.theme, initial.language])
  return <div className="app" style={style}>
    {notice}
    <main className="workspace reader">
      <ReadDocument initial={published} minimap={!smallScreen} />
    </main>
  </div>
}
