import type { MoteDocument } from '../document/model'
import { replaceMainContent } from '../document/model'
import { HistoryContext, useDocumentHistory } from '../document/history'
import type { ViewSettings } from '../app/GlobalSettings'
import { DocumentCanvas } from './DocumentCanvas'

const noop = () => {}

// The same canvas and layout normalization as reading in the app, without persistence.
export function ReadDocument({ initial, zoomHost = null, minimap = false, minimapSize = 'proportional', onReady = noop }: {
  initial: MoteDocument; zoomHost?: HTMLDivElement | null; minimap?: boolean
  minimapSize?: ViewSettings['minimapSize']; onReady?: () => void
}) {
  const history = useDocumentHistory(initial)
  const { doc, setDoc } = history
  return <HistoryContext value={history}><DocumentCanvas doc={doc!} editable={false} zoomHost={zoomHost}
    minimap={minimap} minimapSize={minimapSize} selectedIds={[]} tool={null}
    onSelect={noop} onToolChange={noop} onActions={noop} onActive={noop} onMainReady={onReady}
    onMainChange={(content, merges) => setDoc(current => current && replaceMainContent(current, content, merges))}
    onNoteChange={(id, patch) => setDoc(current => current && ({ ...current, floating: current.floating.map(object => object.id === id ? { ...object, ...patch } : object) }))}
    onFloatingChange={floating => setDoc(current => current && ({ ...current, floating }))} /></HistoryContext>
}
