import { createRoot } from 'react-dom/client'
import type { MoteDocument } from './model'
import { ReadDocument } from '../canvas/ReadDocument'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const tooLarge = 'This document is too large for PNG export in this browser. Export HTML or a .mote document instead.'

async function svgImage(xml: string) {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  await image.decode()
  return image
}

async function settle(surface: HTMLElement) {
  await document.fonts.ready
  await Promise.all([...surface.querySelectorAll('img')].map(image => image.decode()))
  let previous = '', stable = 0
  const deadline = performance.now() + 10000
  while (stable < 3) {
    await frame()
    const signature = surface.innerHTML
    stable = signature === previous ? stable + 1 : 0
    previous = signature
    if (performance.now() > deadline) throw new Error('The document layout has not settled. Please try exporting again.')
  }
}

export async function exportPng(doc: MoteDocument): Promise<Blob> {
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${doc.width + 48}px;height:600px;pointer-events:none`
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  let canvas: HTMLCanvasElement | undefined
  try {
    await new Promise<void>(resolve => root.render(<ReadDocument initial={doc} onReady={resolve} staticWidgets initialScale={1} />))
    await settle(host)
    const source = host.querySelector<HTMLElement>('.stage > .sheet')!
    const width = Math.ceil(doc.width), height = Math.ceil(source.getBoundingClientRect().height)
    if (height > 32767 || width * height > 32_000_000) throw new Error(tooLarge)
    canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(tooLarge)
    context.fillRect(width - 1, height - 1, 1, 1)
    if (!context.getImageData(width - 1, height - 1, 1, 1).data[3]) throw new Error(tooLarge)
    context.clearRect(0, 0, width, height)
    try {
      const probe = await svgImage('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><foreignObject width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml" style="width:1px;height:1px;background:rgb(21,42,63)"></div></foreignObject></svg>')
      context.drawImage(probe, 0, 0)
      if (context.getImageData(0, 0, 1, 1).data.join(',') !== '21,42,63,255') throw new Error()
    } catch {
      throw new Error('This browser cannot render PNG exports. Try a current Chromium browser, or export HTML or .mote instead.')
    }
    context.clearRect(0, 0, width, height)

    const copy = source.cloneNode(true) as HTMLElement
    copy.style.cssText += ';margin:0;zoom:1;box-shadow:none;border-color:transparent;overflow:hidden'
    // Freeze animated images and embed raster pixels, including SVG source images.
    const images = [...source.querySelectorAll('img')]
    for (const [index, image] of [...copy.querySelectorAll('img')].entries()) {
      const original = images[index], raster = document.createElement('canvas')
      raster.width = Math.max(1, Math.ceil(original.getBoundingClientRect().width))
      raster.height = Math.max(1, Math.ceil(original.getBoundingClientRect().height))
      raster.getContext('2d')!.drawImage(original, 0, 0, raster.width, raster.height)
      image.src = raster.toDataURL('image/png')
      // Preserve the original intrinsic aspect ratio after raster rounding.
      image.style.height = `${original.getBoundingClientRect().height}px`
      raster.width = raster.height = 0
    }
    copy.querySelectorAll('[contenteditable], [tabindex]').forEach(element => {
      element.removeAttribute('contenteditable'); element.removeAttribute('tabindex')
    })
    copy.querySelectorAll('.table-column-controls').forEach(element => element.remove())

    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height))
    const foreign = document.createElementNS(ns, 'foreignObject')
    foreign.setAttribute('width', '100%'); foreign.setAttribute('height', '100%')
    const wrapper = document.createElement('div')
    const style = document.createElement('style')
    style.textContent = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join('\n')
    wrapper.append(style, copy); foreign.append(wrapper); svg.append(foreign)
    const image = await svgImage(new XMLSerializer().serializeToString(svg))
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(tooLarge)
    return blob
  } finally {
    root.unmount(); host.remove()
    if (canvas) canvas.width = canvas.height = 0
  }
}
