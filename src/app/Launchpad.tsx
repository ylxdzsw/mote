import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from 'react'
import type { CreationTool } from '../canvas/DocumentCanvas'

export interface LaunchpadPoint { x: number; y: number }

function usePopupPosition(ref: RefObject<HTMLDivElement | null>, point: LaunchpadPoint | null, expanded = false): CSSProperties {
  const [position, setPosition] = useState({ left: 12, top: 12 })
  useLayoutEffect(() => {
    if (!point || !ref.current) return
    const { width, height } = ref.current.getBoundingClientRect()
    setPosition({
      left: Math.max(12, Math.min(point.x, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(point.y, window.innerHeight - height - 12)),
    })
  }, [point, expanded])
  return { position: 'fixed', zIndex: 120, ...position }
}

interface TileEntry {
  kind: CreationTool | 'image' | 'table' | 'html' | 'katex' | 'more'
  label: string
  icon: ReactElement
}

function Icon({ path, rect }: { path: string; rect?: string }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" width="18" height="18">
    {rect && <rect {...Object.fromEntries(rect.split(' ').map(p => p.split(':') as [string, string]))} />}
    {path && <path d={path} />}
  </svg>
}

const TILES: TileEntry[] = [
  { kind: 'text',      label: 'Text box',   icon: <Icon path="M3 4h18M3 9h18M3 14h12" /> },
  { kind: 'rectangle', label: 'Rectangle',  icon: <Icon path="" rect="x:3 y:5 width:18 height:14 rx:1" /> },
  { kind: 'image',     label: 'Image',      icon: <Icon path="M3 3h18v18H3zM3 17l6-5 4 4 3-3 5 4" /> },
  { kind: 'table',     label: 'Table',      icon: <Icon path="M3 10h18M3 15h18M11 4v16" rect="x:3 y:4 width:18 height:16 rx:1" /> },
  { kind: 'line',      label: 'Line',       icon: <Icon path="M4 20 20 4M12 4h8v8" /> },
  { kind: 'code',      label: 'Code',       icon: <Icon path="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" /> },
  { kind: 'ai',        label: 'AI object',  icon: <Icon path="M12 3H3v18h18v-9M6 17l4-5 4 5m1-11 1.2 3.8L23 6l-3.8 1.2L18 11l-1.2-3.8L13 6l3.8-1.2Z" /> },
  { kind: 'more',      label: 'More',       icon: <Icon path="M12 5v.01M12 12v.01M12 19v.01" /> },
]

// Native kinds outside the eight-tile grid. Ellipse/Label/Paragraph arm a
// drawing tool; Formula and the HTML widget run their own setup first.
const MORE_TILES: TileEntry[] = [
  { kind: 'ellipse',   label: 'Ellipse',     icon: <Icon path="" rect="x:3 y:5 width:18 height:14 rx:9" /> },
  { kind: 'label',     label: 'Label',       icon: <Icon path="M7 8V5h10v3M12 5v12M9 17h6M4 21h16" /> },
  { kind: 'katex',     label: 'Formula',     icon: <Icon path="M5 5h14M5 19h14M7 5v14M17 5v14m-7-10 4 3-4 3" /> },
  { kind: 'html',      label: 'HTML widget', icon: <Icon path="m8 6-5 6 5 6M16 6l5 6-5 6M14 3l-4 18" /> },
  { kind: 'paragraph', label: 'Paragraph',   icon: <Icon path="M13 19V5H9a4 4 0 0 0 0 8h4M17 5v14M10 5h9" /> },
]

interface Props {
  point: LaunchpadPoint | null
  /** Header Add button: anchor under the button rather than at a fixed corner. */
  anchor?: LaunchpadPoint | null
  onChoose: (kind: string) => void
  onClose: () => void
}

export function Launchpad({ point, anchor, onChoose, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const origin = point ?? anchor ?? null
  const open = !!origin
  const style = usePopupPosition(ref, origin, more)

  useEffect(() => {
    if (!open) return
    const menu = ref.current
    const previous = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    first?.focus({ preventScroll: true })
    function outside(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', onClose)
      if (document.activeElement === document.body || menu?.contains(document.activeElement)) previous?.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => { if (!open) setMore(false) }, [open])
  useEffect(() => { if (more) ref.current?.querySelector<HTMLButtonElement>('[data-more-list] [role="menuitem"]')?.focus({ preventScroll: true }) }, [more])

  if (!open || !origin) return null

  function navigate(event: React.KeyboardEvent) {
    if (event.key === 'Tab') { onClose(); return }
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (more) { setMore(false); ref.current?.querySelector<HTMLButtonElement>('[data-more-trigger]')?.focus({ preventScroll: true }) }
      else onClose()
      return
    }
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']
    if (!keys.includes(event.key)) return
    const scope = more ? '[data-more-list] ' : ':scope > .launchpad-grid > '
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>(`${scope}[role="menuitem"]`)]
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const cols = more ? 1 : 2
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
      : event.key === 'ArrowDown' ? index + cols : index - cols
    items[Math.max(0, Math.min(items.length - 1, next))]?.focus()
  }

  const choose = (kind: string) => { setMore(false); onChoose(kind) }

  return <div ref={ref} className="launchpad" role="menu" aria-label="Add to the page" style={style} onKeyDown={navigate}>
    <div className="launchpad-header">
      <span>Add to the page</span>
      <button aria-label="Close" className="launchpad-close" onClick={onClose}>×</button>
    </div>
    <div className="launchpad-grid">
      {TILES.map(tile => tile.kind === 'more'
        ? <button key="more" role="menuitem" data-more-trigger className="launchpad-tile" tabIndex={-1}
            aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}>
            {tile.icon}<span>{tile.label}</span>
          </button>
        : <button key={String(tile.kind)} role="menuitem" className="launchpad-tile" tabIndex={-1}
            onClick={() => choose(String(tile.kind))}>
            {tile.icon}<span>{tile.label}</span>
          </button>)}
    </div>
    {more && <div className="launchpad-more" role="menu" aria-label="More objects" data-more-list>
      <p className="launchpad-more-heading">More objects</p>
      {MORE_TILES.map(tile => <button key={String(tile.kind)} role="menuitem" className="launchpad-tile" tabIndex={-1}
        onClick={() => choose(String(tile.kind))}>
        {tile.icon}<span>{tile.label}</span>
      </button>)}
    </div>}
    <p className="launchpad-hint">Choose a tool, then place · Esc cancels</p>
  </div>
}
