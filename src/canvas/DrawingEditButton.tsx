export function DrawingEditButton({ onEdit, label = 'Edit drawing', scale = 1 }: {
  onEdit: () => void; label?: string; scale?: number
}) {
  return <button className="drawing-edit-button" aria-label={label} title={label}
    style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
    onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onEdit() }}>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z" /></svg>
  </button>
}
