import { createRoot } from 'react-dom/client'
import type { MoteDocument } from './model'
import { ReadDocument } from '../canvas/ReadDocument'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

async function settle(surface: HTMLElement, objectCount: number) {
  const deadline = performance.now() + 10000
  const tick = async () => {
    await frame()
    if (performance.now() > deadline) throw new Error('The document layout has not settled. Please try exporting again.')
  }
  // Flow objects mount after their normal-flow slots have been measured. Wait for
  // their images and math fonts too, not just the resources on the first frame.
  while (surface.querySelectorAll('.sheet [data-note-id]').length !== objectCount) await tick()
  await Promise.all([...surface.querySelectorAll<HTMLImageElement>('img[src]')].map(image => image.decode()))
  await document.fonts.ready
  let previous = '', stable = 0
  while (stable < 3) {
    await tick()
    const signature = surface.innerHTML
    stable = signature === previous && !surface.querySelector('[data-code-loading]') ? stable + 1 : 0
    previous = signature
  }
}

export async function captureSheet<T>(doc: MoteDocument, capture: (sheet: HTMLElement) => T | Promise<T>): Promise<T> {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${doc.page.width + 48}px;height:600px;pointer-events:none`
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await new Promise<void>(resolve => root.render(<ReadDocument initial={doc} onReady={resolve} staticWidgets initialScale={1} />))
    await settle(host, doc.objects.length)
    const sheet = host.querySelector<HTMLElement>('.stage .sheet')!
    return await capture(sheet)
  } finally { root.unmount(); host.remove() }
}
