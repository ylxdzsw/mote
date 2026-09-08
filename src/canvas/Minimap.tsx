import { useLayoutEffect, useRef, type PointerEvent, type RefObject } from 'react'
import type { ViewSettings } from '../app/GlobalSettings'

interface Props {
  stage: RefObject<HTMLDivElement | null>
  sheet: RefObject<HTMLDivElement | null>
  canvasId: string
  sizing: ViewSettings['minimapSize']
}

interface Geometry {
  ratio: number
  overflow: number
  maximum: number
  travel: number
  thumbHeight: number
}

interface Bookmark {
  heading: HTMLElement
  button: HTMLButtonElement
  y: number
  scrollY: number
}

export function Minimap({ stage, sheet, canvasId, sizing }: Props) {
  const pane = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const labels = useRef<HTMLElement>(null)
  const image = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const hit = useRef<HTMLDivElement>(null)
  const geometry = useRef<Geometry>({ ratio: 1, overflow: 0, maximum: 0, travel: 0, thumbHeight: 0 })
  const drag = useRef<{ y: number; scroll: number } | null>(null)

  useLayoutEffect(() => {
    const viewport = stage.current!
    const source = sheet.current!
    const rail = track.current!
    const navigation = labels.current!
    const container = pane.current!
    let frame = 0
    let dirty = true
    let bookmarks: Bookmark[] = []

    function headingFocusOffset() { return Math.min(120, viewport.clientHeight * .15) }

    function paint() {
      frame = 0
      if (dirty) {
        dirty = false
        // An inert DOM snapshot shares the real layout and theme, without another editor.
        const miniature = source.cloneNode(true) as HTMLDivElement
        miniature.className = 'sheet is-reading minimap-sheet'
        miniature.style.zoom = '1'
        miniature.style.height = `${source.offsetHeight}px`
        miniature.querySelectorAll('.floating-border-right, .segment-boundaries').forEach(node => node.remove())
        miniature.querySelectorAll<HTMLElement>('*').forEach(node => {
          for (const name of node.getAttributeNames()) {
            if (name === 'id' || name === 'tabindex' || name === 'contenteditable' || name === 'role' || name.startsWith('aria-')) node.removeAttribute(name)
          }
          node.classList.remove('ProseMirror-selectednode', 'ProseMirror-focused', 'is-selected', 'selectedCell')
        })
        const rect = source.getBoundingClientRect()
        const zoom = rect.width / source.offsetWidth
        const pageTop = (rect.top - viewport.getBoundingClientRect().top - viewport.clientTop + viewport.scrollTop) / zoom
        const width = Math.max(source.offsetWidth, source.scrollWidth)
        const x = (rail.clientWidth - 12) / width
        const height = viewport.scrollHeight / zoom
        const y = sizing === 'fit' ? Math.min(x, rail.clientHeight / height) : x
        const mapHeight = height * y
        const thumbHeight = Math.min(rail.clientHeight, viewport.clientHeight / zoom * y)
        const overflow = Math.max(0, mapHeight - rail.clientHeight)
        geometry.current = {
          ratio: y / zoom,
          overflow,
          maximum: viewport.scrollHeight - viewport.clientHeight,
          travel: Math.max(0, mapHeight - overflow - thumbHeight),
          thumbHeight,
        }
        miniature.style.transform = `translate(6px, ${pageTop * y}px) scale(${x}, ${y})`
        image.current!.replaceChildren(miniature)

        const existing = new Map(bookmarks.map(bookmark => [bookmark.heading, bookmark.button]))
        bookmarks = [...source.querySelectorAll<HTMLElement>('.main-text [data-semantic="heading"]')].map(heading => {
          let button = existing.get(heading)
          if (!button) {
            button = document.createElement('button')
            button.type = 'button'
            button.className = 'minimap-bookmark'
            button.onpointerdown = event => event.preventDefault()
            button.onclick = () => {
              viewport.scrollTop = Math.ceil(viewport.scrollTop + heading.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop - headingFocusOffset())
            }
          }
          const text = heading.textContent?.trim() || 'Untitled heading'
          if (button.textContent !== text) button.textContent = text
          button.title = text
          button.setAttribute('aria-label', `Go to heading: ${text}`)
          const scrollY = heading.getBoundingClientRect().top - rect.top + pageTop * zoom
          return { heading, button, y: scrollY / zoom * y, scrollY }
        }).sort((a, b) => a.y - b.y)
        for (const [heading, button] of existing) {
          if (!bookmarks.some(bookmark => bookmark.heading === heading)) button.remove()
        }
        bookmarks.forEach(({ button }, index) => {
          if (navigation.children[index] !== button) navigation.insertBefore(button, navigation.children[index] ?? null)
        })
      }

      const { maximum, travel, overflow, thumbHeight } = geometry.current
      const progress = maximum > 0 ? Math.max(0, Math.min(1, viewport.scrollTop / maximum)) : 0
      image.current!.style.transform = `translateY(${-progress * overflow}px)`
      thumb.current!.style.height = `${thumbHeight}px`
      thumb.current!.style.transform = `translateY(${progress * travel}px)`
      const hitHeight = Math.min(rail.clientHeight, Math.max(24, thumbHeight))
      hit.current!.style.height = `${hitHeight}px`
      hit.current!.style.transform = `translateY(${Math.max(0, Math.min(rail.clientHeight - hitHeight, progress * travel + (thumbHeight - hitHeight) / 2))}px)`
      rail.setAttribute('aria-valuemax', String(Math.round(maximum)))
      rail.setAttribute('aria-valuenow', String(Math.round(viewport.scrollTop)))
      rail.setAttribute('aria-valuetext', maximum > 0 ? `${Math.round(progress * 100)}% through document` : 'Entire document visible')
      rail.dataset.scrollable = String(maximum > 0)

      const offset = progress * overflow
      const current = bookmarks.findLast(bookmark => bookmark.scrollY <= viewport.scrollTop + headingFocusOffset())
      const visible = bookmarks.filter(({ button, y }) => {
        button.hidden = y < offset || y > offset + rail.clientHeight
        if (button === current?.button) button.setAttribute('aria-current', 'location')
        else button.removeAttribute('aria-current')
        return !button.hidden
      })
      // Keep nearby headings readable without changing their navigation targets.
      const tops: number[] = []
      visible.forEach((bookmark, index) => {
        tops.push(Math.max(bookmark.y - offset - 9, index ? tops[index - 1] + 20 : 0))
      })
      if (visible.length * 20 <= rail.clientHeight) {
        for (let index = tops.length - 1; index >= 0; index--) {
          tops[index] = Math.min(tops[index], index === tops.length - 1 ? rail.clientHeight - 20 : tops[index + 1] - 20)
        }
      }
      visible.forEach(({ button }, index) => { button.style.top = `${tops[index]}px` })
    }

    function schedule() { if (!frame) frame = requestAnimationFrame(paint) }
    function refresh() { dirty = true; schedule() }
    const mutation = new MutationObserver(refresh)
    mutation.observe(source, { subtree: true, childList: true, characterData: true, attributes: true })
    const resize = new ResizeObserver(refresh)
    resize.observe(viewport)
    resize.observe(source)
    resize.observe(rail)
    document.fonts.addEventListener('loadingdone', refresh)
    viewport.addEventListener('scroll', schedule, { passive: true })
    const wheel = (event: WheelEvent) => {
      if (navigation.contains(event.target as Node) && navigation.scrollHeight > navigation.clientHeight && !event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) return
      viewport.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1)
    }
    container.addEventListener('wheel', wheel, { passive: false })
    paint()
    return () => {
      cancelAnimationFrame(frame)
      mutation.disconnect()
      resize.disconnect()
      navigation.replaceChildren()
      document.fonts.removeEventListener('loadingdone', refresh)
      viewport.removeEventListener('scroll', schedule)
      container.removeEventListener('wheel', wheel)
    }
  }, [stage, sheet, sizing])

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    const viewport = stage.current!
    const { maximum, overflow, ratio } = geometry.current
    if (maximum <= 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    if (event.target !== hit.current) {
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top
      const offset = viewport.scrollTop / maximum * overflow
      viewport.scrollTop = (y + offset) / ratio - viewport.clientHeight / 2
    }
    drag.current = { y: event.clientY, scroll: viewport.scrollTop }
    event.currentTarget.classList.add('is-dragging')
  }

  function finish() { drag.current = null; track.current!.classList.remove('is-dragging') }

  return <div className="minimap-pane" ref={pane}>
    <div className="minimap" ref={track} role="scrollbar" tabIndex={0}
    aria-label="Document minimap" aria-controls={canvasId} aria-orientation="vertical"
    aria-valuemin={0} aria-valuemax={0} aria-valuenow={0}
    onPointerDown={start}
    onPointerMove={event => {
      const { maximum, travel } = geometry.current
      if (drag.current && travel > 0) stage.current!.scrollTop = drag.current.scroll + (event.clientY - drag.current.y) / travel * maximum
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={event => {
      const viewport = stage.current!
      const targets: Record<string, number> = {
        ArrowUp: viewport.scrollTop - 40, ArrowDown: viewport.scrollTop + 40,
        PageUp: viewport.scrollTop - viewport.clientHeight, PageDown: viewport.scrollTop + viewport.clientHeight,
        Home: 0, End: viewport.scrollHeight,
      }
      if (!(event.key in targets) || event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      viewport.scrollTop = targets[event.key]
    }}>
    <div className="minimap-image" ref={image} aria-hidden="true" inert />
    <div className="minimap-viewport" ref={thumb} aria-hidden="true" />
    <div className="minimap-hit" ref={hit} aria-hidden="true" />
    </div>
    <nav className="minimap-bookmarks" ref={labels} aria-label="Heading bookmarks" />
  </div>
}
