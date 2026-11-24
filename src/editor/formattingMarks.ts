import { createContext, useLayoutEffect, type RefObject } from 'react'

export const ShowFormattingMarks = createContext(false)

export function useFormattingMarks(sheet: RefObject<HTMLDivElement | null>, enabled: boolean, scale: number) {
  useLayoutEffect(() => {
    if (!enabled) return
    const surface = sheet.current!, stage = surface.closest<HTMLElement>('.stage')!
    const range = document.createRange()
    let frame = 0
    function paint() {
      frame = 0
      const viewport = stage.getBoundingClientRect()
      for (const layer of surface.querySelectorAll<HTMLElement>('.formatting-layer')) {
        const editor = layer.previousElementSibling!, origin = layer.getBoundingClientRect()
        // Keep paint mutations out of editing/layout observers and minimap clones.
        const root = layer.shadowRoot ?? layer.attachShadow({ mode: 'open' })
        const marks: string[] = []
        for (const p of editor.querySelectorAll('p[data-semantic]')) {
          const box = p.getBoundingClientRect()
          if (!box.height || box.bottom < viewport.top || box.top > viewport.bottom || p.closest('.text-content') !== editor) continue
          const size = parseFloat(getComputedStyle(p).fontSize)
          function mark(sign: '·' | '→' | '↵' | '¶') {
            const r = range.getBoundingClientRect()
            if (!r.height || r.bottom < viewport.top || r.top > viewport.bottom) return
            const x = ((r.left + (sign === '·' ? r.width / 2 : 0) - origin.left) / scale).toFixed(2)
            const y = ((r.top + r.height / 2 - origin.top) / scale).toFixed(2)
            marks.push(sign === '·' ? `<circle cx="${x}" cy="${y}" r="${size * .065}"/>`
              : `<text x="${x}" y="${y}" font-size="${size * .86}">${sign}</text>`)
          }
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
          range.selectNodeContents(p); range.collapse(true)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node instanceof Text) {
              for (const match of node.data.matchAll(/[ \t]/g)) {
                range.setStart(node, match.index); range.setEnd(node, match.index + 1)
                mark(match[0] === ' ' ? '·' : '→')
              }
              range.selectNodeContents(node); range.collapse(false)
            } else if (node instanceof HTMLBRElement) {
              range.selectNode(node)
              if (!node.classList.contains('ProseMirror-trailingBreak')) mark('↵')
            }
          }
          // A trailing editor filler BR supplies the real caret box for an empty final line.
          mark('¶')
        }
        root.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" fill="currentColor" font-family="sans-serif" dominant-baseline="central">${marks.join('')}</svg>`
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const changes = new MutationObserver(schedule)
    changes.observe(surface, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'data-semantic', 'data-repel'] })
    const resize = new ResizeObserver(schedule)
    resize.observe(surface); resize.observe(stage)
    stage.addEventListener('scroll', schedule)
    document.fonts.addEventListener('loadingdone', schedule)
    schedule()
    return () => {
      changes.disconnect(); resize.disconnect(); cancelAnimationFrame(frame)
      stage.removeEventListener('scroll', schedule)
      document.fonts.removeEventListener('loadingdone', schedule)
    }
  }, [sheet, enabled, scale])
}
