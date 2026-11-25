import { useMemo, type ReactNode } from 'react'
import { publishDocument } from '../../shared/document.mjs'
import { useMedia } from '../app/useMedia'
import { ReadDocument } from '../canvas/ReadDocument'
import type { MoteDocument } from '../document/model'
import { uiThemeVariables } from '../theme/ui'

// Only the source differs: authenticated working copy, local preview, or public share.
export function ReaderPage({ initial, notice }: { initial: MoteDocument; notice?: ReactNode }) {
  const smallScreen = useMedia('(max-width: 1050px)')
  const published = useMemo(() => publishDocument(initial), [initial])
  const style = useMemo(() => uiThemeVariables(initial.theme, initial.language ?? 'en'), [initial.theme, initial.language])
  return <div className="app reader-page" style={style}>
    {notice}
    <main className="workspace reader">
      <ReadDocument key={initial.id} initial={published} minimap={!smallScreen} nativeScroll />
    </main>
  </div>
}
