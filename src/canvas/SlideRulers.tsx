import type { CSSProperties } from 'react'
import { PanelIcon } from '../app/PanelIcon'
import type { SlideGeometry } from './floatingGeometry'
import './SlideRulers.css'

// Mount beside the sheet, inside its footprint. It stays above every object,
// but outside the DOM captured by minimap and PNG snapshots.
export function SlideRulers({ slides, width, scale, style, onSelect, onBorder, onAppend }: {
  slides: SlideGeometry[]; width: number; scale: number; style?: CSSProperties
  onSelect?: (index: number) => void; onBorder?: (index: number) => void
  onAppend?: () => void
}) {
  if (!slides.length) return null
  return <div className="slide-rulers" aria-label="Slide boundaries"
    style={{ ...style, width, transform: `scale(${scale})`, '--ruler-scale': scale } as CSSProperties}>
    {slides.map(slide => <div key={slide.id ?? 'first'}>
      <div className="slide-ruler" style={{ top: slide.top }}>
        <button className="slide-border-target" data-slide-control aria-label={`Insert before slide ${slide.index + 1}`} title="Paste slides at this border"
          onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onBorder?.(slide.index) }} onClick={event => { if (event.detail === 0) onBorder?.(slide.index) }} />
        <button className="slide-number" data-slide-control aria-label={`Select slide ${slide.index + 1}`} title={`Select slide ${slide.index + 1}`}
          onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onSelect?.(slide.index) }} onClick={event => { if (event.detail === 0) onSelect?.(slide.index) }}>{slide.index + 1}</button>
      </div>
      {slide.height > slide.savedHeight + .5 && <div className="slide-ruler slide-ruler-saved" style={{ top: slide.top + slide.savedHeight }}><span>Content below is cropped</span></div>}
    </div>)}
    <div className="slide-ruler" style={{ top: slides.at(-1)!.top + slides.at(-1)!.height }}>
      <button className="slide-border-target" data-slide-control aria-label="Insert after last slide" title="Paste slides at this border"
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onBorder?.(slides.length) }} onClick={event => { if (event.detail === 0) onBorder?.(slides.length) }} />
    </div>
    {onAppend && <button className="slide-append" data-slide-control style={{ top: slides.at(-1)!.top + slides.at(-1)!.height }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation() }} onClick={onAppend}>
      <PanelIcon name="plus" />Add slide
    </button>}
  </div>
}
