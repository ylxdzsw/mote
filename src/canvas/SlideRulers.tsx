import type { CSSProperties } from 'react'
import { PanelIcon } from '../app/PanelIcon'
import type { SlideGeometry } from './floatingGeometry'
import './SlideRulers.css'

// Mount beside the sheet, inside its footprint. It stays above every object,
// but outside the DOM captured by minimap and PNG snapshots.
export function SlideRulers({ slides, width, scale, style, onAppend }: {
  slides: SlideGeometry[]; width: number; scale: number; style?: CSSProperties
  onAppend?: () => void
}) {
  if (!slides.length) return null
  return <div className="slide-rulers" aria-label="Slide boundaries"
    style={{ ...style, width, transform: `scale(${scale})`, '--ruler-scale': scale } as CSSProperties}>
    {slides.map(slide => <div key={slide.id ?? 'first'}>
      <div className="slide-ruler" style={{ top: slide.top }}>
        <span aria-label={`Slide ${slide.index + 1}`}>{slide.index + 1}</span>
      </div>
      {slide.height > slide.savedHeight + .5 && <div className="slide-ruler slide-ruler-saved" style={{ top: slide.top + slide.savedHeight }}><span>Content below is cropped</span></div>}
    </div>)}
    <div className="slide-ruler" style={{ top: slides.at(-1)!.top + slides.at(-1)!.height }} />
    {onAppend && <button className="slide-append" data-slide-control style={{ top: slides.at(-1)!.top + slides.at(-1)!.height }}
      onPointerDown={event => { event.preventDefault(); event.stopPropagation() }} onClick={onAppend}>
      <PanelIcon name="plus" />Add slide
    </button>}
  </div>
}
