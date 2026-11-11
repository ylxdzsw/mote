import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import type { MoteDocument } from '../document/model'
import { objectSlideIndex, slideRanges } from '../document/slides'
import { isComposingKey } from '../editor/composition'

const interactive = 'a[href], button, input, textarea, select, [contenteditable="true"], iframe, [data-widget-live]'

// A viewport onto the existing reader sheet: no second renderer or document edits.
export function usePresentation(doc: MoteDocument, enabled: boolean, stage: RefObject<HTMLDivElement | null>, sheet: RefObject<HTMLDivElement | null>, nativeScroll = false) {
  const height = doc.page.slideHeight
  const available = enabled && height !== undefined
  const count = slideRanges(doc).length
  const [index, setIndex] = useState<number | null>(null)
  const active = index !== null
  const [scale, setScale] = useState(1)
  const [entryVisible, setEntryVisible] = useState(true)
  const entry = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restore = useRef<{ index: number; left: number } | null>(null)

  function reveal() {
    if (!available || active) return
    setEntryVisible(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setEntryVisible(false), 2200)
  }
  useEffect(() => {
    reveal()
    return () => clearTimeout(timer.current)
  }, [available, active])

  function enter() {
    const viewport = stage.current!, page = sheet.current!
    const zoom = page.getBoundingClientRect().width / doc.page.width
    const top = nativeScroll ? 0 : viewport.getBoundingClientRect().top
    const viewportHeight = nativeScroll ? document.documentElement.clientHeight : viewport.clientHeight
    const y = (top + Math.min(120, viewportHeight * .15) - page.getBoundingClientRect().top) / zoom
    const current = Math.max(0, Math.min(count - 1, Math.floor(y / height!)))
    restore.current = { index: current, left: nativeScroll ? window.scrollX : viewport.scrollLeft }
    window.getSelection()?.removeAllRanges()
    setIndex(current)
    viewport.focus({ preventScroll: true })
  }
  function move(delta: number) {
    window.getSelection()?.removeAllRanges()
    setIndex(current => current === null ? null : Math.max(0, Math.min(count - 1, current + delta)))
    stage.current!.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!active) return
    const viewport = stage.current!
    function fit() { setScale(Math.min(viewport.clientWidth / doc.page.width, viewport.clientHeight / height!)) }
    fit()
    viewport.scrollTo(0, 0)
    // Do not paint the resized viewport with the previous slide fit.
    const observer = new ResizeObserver(() => flushSync(fit))
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [active, doc.page.width, height, stage])

  useLayoutEffect(() => {
    if (active || !restore.current) return
    const viewport = stage.current!, page = sheet.current!
    const { index: last, left } = restore.current
    restore.current = null
    const zoom = page.getBoundingClientRect().width / doc.page.width
    const offset = page.getBoundingClientRect().top + last * height! * zoom - parseFloat(getComputedStyle(viewport).paddingTop)
    if (nativeScroll) window.scrollTo(left, window.scrollY + offset)
    else {
      viewport.scrollTop += offset - viewport.getBoundingClientRect().top
      viewport.scrollLeft = left
    }
    entry.current?.focus({ preventScroll: true })
  }, [active, doc.page.width, height, sheet, stage, nativeScroll])

  // Off-slide links and widgets must not take focus or appear in the accessibility tree.
  useEffect(() => {
    if (!active) return
    const page = sheet.current!
    const blocks = [...page.querySelectorAll<HTMLElement>('.main-text > .text-content > .tiptap > *')]
    let slide = 0
    for (const block of blocks) {
      if (block.hasAttribute('data-slide-break')) slide++
      block.inert = slide !== index
    }
    const objects = [...page.querySelectorAll<HTMLElement>('[data-note-id]')]
    const objectsById = new Map(doc.objects.map(object => [object.id, object]))
    for (const element of objects) {
      const object = objectsById.get(element.dataset.noteId!)
      if (object) element.inert = objectSlideIndex(doc, object) !== index
    }
    return () => { for (const element of [...blocks, ...objects]) element.inert = false }
  }, [active, index, doc, sheet])

  useEffect(() => {
    if (!active) return
    function exit() {
      restore.current!.index = index!
      setIndex(null)
    }
    function key(event: KeyboardEvent) {
      if (isComposingKey(event) || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        exit()
      } else if (!event.defaultPrevented && !(event.target as Element).closest(interactive)) {
        if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return
        event.preventDefault()
        move(event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)
      }
    }
    function widgetKey(event: MessageEvent) {
      if (event.data?.type !== 'mote-widget-escape') return
      const widget = [...sheet.current!.querySelectorAll('iframe')].find(frame => frame.contentWindow === event.source)
      if (widget && !widget.closest('[inert]')) exit()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('message', widgetKey)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('message', widgetKey)
    }
  }, [active, index, count])

  function click(event: MouseEvent) {
    if (!active || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if ((event.target as Element).closest(interactive) || !window.getSelection()?.isCollapsed) return
    move(1)
  }

  return { active, index, scale, reveal, click,
    entry: available && !active && <button ref={entry} type="button" className={`present-button${entryVisible ? ' is-visible' : ''}`}
      title="Present slides · Click or use arrow keys to navigate · Esc returns to reading" onClick={enter}>Present</button>,
  }
}
