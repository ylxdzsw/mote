import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FloatingImage, MoteDocument } from '../document/model'
import { readImage } from '../document/image'
import { useHistory } from '../document/history'
import { isComposingKey } from '../editor/composition'
import type { CreationTool } from './DocumentCanvas'

interface Props {
  doc: MoteDocument; editable: boolean; scale: number; tool: CreationTool
  stage: RefObject<HTMLDivElement | null>
  onStart: () => void; onReady: (image: FloatingImage, ratio: number) => void
}

// Clipboard acquisition feeds the same placement tool as a picked image.
export function useImagePlacement({ doc, editable, scale, tool, stage, onStart, onReady }: Props) {
  const history = useHistory()
  const [notice, setNotice] = useState('')
  const [active, setActive] = useState(false)
  const generation = useRef(0)
  function cancel() { generation.current++; setActive(false); setNotice('') }
  useLayoutEffect(() => { cancel(); return () => { generation.current++ } }, [doc, editable, scale, history.revision])
  useLayoutEffect(() => { if (tool) cancel() }, [tool])

  useLayoutEffect(() => {
    if (!editable) return
    async function paste(event: ClipboardEvent) {
      const data = event.clipboardData, target = document.activeElement
      if (!data || !(target instanceof HTMLElement) || !stage.current?.contains(target) || target.closest('input, textarea, select, iframe')) return
      const html = data.getData('text/html')
      if ([...data.types].some(type => type.startsWith('application/x-mote-')) || /data-mote-(floating|segment|paragraphs)/.test(html)) return
      if (data.getData('text/plain').trim()) return
      if (html && new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim()) return
      const files = [...data.files]
      if (!files.length || files.some(file => !file.type.startsWith('image/'))) return
      event.preventDefault(); event.stopImmediatePropagation()
      cancel(); onStart()
      if (files.length !== 1) { setNotice('Paste one image at a time, or drop multiple image files onto the document.'); return }
      stage.current!.focus({ preventScroll: true })
      const token = generation.current
      setActive(true); setNotice('Opening clipboard image…')
      try {
        const src = await readImage(files[0])
        const image = new Image(); image.src = src; await image.decode()
        if (generation.current !== token) return
        const width = Math.min(340, image.naturalWidth + 18, doc.page.width - doc.page.margins.left - doc.page.margins.right)
        setActive(false); setNotice('')
        onReady({ id: crypto.randomUUID(), kind: 'image', src, alt: '', layout: { width, placement: { type: 'flow', x: 'center' } } }, image.naturalWidth / image.naturalHeight)
      } catch (error) { if (generation.current === token) { setActive(false); setNotice((error as Error).message) } }
    }
    function key(event: KeyboardEvent) {
      if (active && event.key === 'Escape' && !isComposingKey(event)) { event.preventDefault(); cancel() }
    }
    function down() { if (active) cancel() }
    window.addEventListener('paste', paste, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('paste', paste, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('blur', cancel)
    }
  })
  return { active, notice }
}
