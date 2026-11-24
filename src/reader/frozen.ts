import { publishDocument } from '../../shared/document.mjs'
import { captureSheet } from '../document/capture'
import type { MoteDocument } from '../document/model'
import { widgetPage } from '../canvas/HTMLWidgetView'
import { mathCss } from '../canvas/MathDisplay'
import { loadCodeLanguage } from '../editor/codeLanguages'
import { pageColor } from '../theme/palette'
import pageCss from '../app/styles.css?inline'
import floatCss from '../canvas/floating.css?inline'
import embedCss from '../canvas/embeds.css?inline'
import codeCss from '../canvas/code.css?inline'

export async function exportFrozenHtml(documentValue: MoteDocument, title: string) {
  const doc = publishDocument(documentValue)
  await Promise.all(doc.objects.flatMap(o => o.kind === 'code' && o.source ? [loadCodeLanguage(o.language)] : []))
    .catch(() => { throw new Error('Code highlighting could not load. Reconnect and try exporting again.') })

  return captureSheet(doc, source => {
    // No browsing context: widget scripts start only when the recipient opens the file.
    const file = document.implementation.createHTMLDocument(title)
    file.documentElement.lang = source.lang
    const charset = file.createElement('meta'), viewport = file.createElement('meta')
    charset.setAttribute('charset', 'utf-8')
    viewport.name = 'viewport'; viewport.content = `width=${Math.ceil(doc.page.width)}`
    file.head.prepend(charset, viewport)
    const sheet = file.importNode(source, true)
    const main = file.createElement('main')
    main.append(sheet); file.body.append(main)
    sheet.style.transform = 'none'
    file.documentElement.style.background = pageColor(doc.theme)
    sheet.querySelectorAll('.table-column-controls, .ProseMirror-gapcursor, .ProseMirror-separator').forEach(e => e.remove())
    sheet.querySelectorAll('[contenteditable]').forEach(e => {
      e.removeAttribute('contenteditable'); e.removeAttribute('tabindex')
      if (e.getAttribute('role') === 'textbox') {
        e.removeAttribute('role'); e.removeAttribute('aria-multiline'); e.removeAttribute('aria-label')
      }
    })
    sheet.querySelectorAll('[data-table-header] tr:first-child td').forEach(e => e.setAttribute('role', 'columnheader'))

    // Keep the common stacking context. CSS anchors avoid reparenting Floats
    // (and putting invalid block markup inside an anchor paragraph).
    const anchors = new Map([...sheet.querySelectorAll<HTMLElement>('.main-text > .text-content > .tiptap > [data-id]')]
      .map((block, i) => [block.dataset.id, { block, name: `--block-${i}` }]))
    for (const object of doc.objects) {
      const selector = `[data-note-id="${CSS.escape(object.id)}"]`
      const note = sheet.querySelector<HTMLElement>(selector)!
      const placement = object.layout.placement
      if (placement.type === 'float' && placement.anchorId) {
        const anchor = anchors.get(placement.anchorId)!
        const target = anchor.block.querySelector<HTMLElement>('[data-in-flow]') ?? anchor.block
        target.style.setProperty('anchor-name', anchor.name)
        note.style.setProperty('--anchored-top', `calc(anchor(${anchor.name} top, ${parseFloat(note.style.top) - placement.y}px) + ${placement.y}px)`)
        note.classList.add('anchored-float')
      }
      if (object.kind === 'image') {
        const image = note.querySelector('img')!
        const original = source.querySelector<HTMLImageElement>(`${selector} img`)!
        image.width = original.naturalWidth; image.height = original.naturalHeight
      } else if (object.kind === 'html') {
        const frame = file.createElement('iframe')
        frame.title = object.alt || 'HTML widget'
        frame.setAttribute('sandbox', 'allow-scripts')
        frame.srcdoc = widgetPage(object.html)
        note.querySelector('.widget-screenshot')!.replaceWith(frame)
      }
    }

    const style = file.createElement('style')
    style.textContent = [pageCss, floatCss, embedCss, codeCss, doc.objects.some(o => o.kind === 'formula') ? mathCss : '', `
html, body { height: auto; overflow: visible; overscroll-behavior: auto; }
.tiptap { white-space: break-spaces; font-variant-ligatures: none; }
[data-flow] { white-space: normal; }
.sheet { print-color-adjust: exact; }
@supports (top: anchor(--block top)) { .anchored-float { top: var(--anchored-top) !important; } }
`].join('\n')
    file.head.append(style)
    return new Blob(['<!doctype html>\n', file.documentElement.outerHTML], { type: 'text/html' })
  })
}
