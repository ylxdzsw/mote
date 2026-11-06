import { createRoot } from 'react-dom/client'
import type { MoteDocument } from './model'
import { ReadDocument } from '../canvas/ReadDocument'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

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
    stable = signature === previous && !surface.querySelector('[data-code-loading]') ? stable + 1 : 0
    previous = signature
    if (performance.now() > deadline) throw new Error('The document layout has not settled. Please try exporting again.')
  }
}

export function exportPng(doc: MoteDocument, scale: 1 | 2 = 1): Promise<Blob> {
  return renderPng(doc, scale)
}

export function exportObjectPng(doc: MoteDocument, objectId: string, scale: 1 | 2 = 2): Promise<Blob> {
  return renderPng(doc, scale, objectId)
}

function objectSurface(sheet: HTMLElement, objectId: string) {
  const object = sheet.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(objectId)}"]`)
  const body = object?.querySelector<HTMLElement>(':scope > .object-body')
  if (!object || !body) throw new Error('The target object is not available for PNG export.')
  const outer = object.getBoundingClientRect()
  const bounds = object.classList.contains('has-caption-support') ? body.getBoundingClientRect() : outer
  const copy = sheet.cloneNode(false) as HTMLElement
  copy.removeAttribute('data-slides')
  copy.style.cssText += `;width:${bounds.width}px;height:${bounds.height}px;min-height:0;padding:0;border:0`
  // Keep inherited theme and selector context, without page geometry or siblings.
  const ancestors: HTMLElement[] = []
  for (let parent = object.parentElement; parent && parent !== sheet; parent = parent.parentElement) ancestors.unshift(parent)
  let mount = copy
  for (const ancestor of ancestors) {
    const context = ancestor.cloneNode(false) as HTMLElement
    context.style.cssText += ';display:contents;transform:none;clip-path:none'
    mount.append(context); mount = context
  }
  const isolated = object.cloneNode(false) as HTMLElement
  isolated.style.cssText += `;position:absolute;left:${outer.left - bounds.left}px;top:${outer.top - bounds.top}px;width:${outer.width}px;margin:0;transform:none;clip-path:none`
  isolated.append(body.cloneNode(true)); mount.append(isolated)
  return { source: body, copy, width: bounds.width, height: bounds.height }
}

async function renderPng(doc: MoteDocument, scale: 1 | 2, objectId?: string): Promise<Blob> {
  const tooLarge = `This document is too large for ${scale}× PNG export in this browser. ${scale === 2 ? 'Try 1× resolution, or export' : 'Export'} HTML or a .mote document instead.`
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${doc.page.width + 48}px;height:600px;pointer-events:none`
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  let canvas: HTMLCanvasElement | undefined
  try {
    await new Promise<void>(resolve => root.render(<ReadDocument initial={doc} onReady={resolve} staticWidgets initialScale={1} />))
    await settle(host)
    const sheet = host.querySelector<HTMLElement>('.stage .sheet')!
    const surface = objectId === undefined
      ? { source: sheet, copy: undefined, width: doc.page.width, height: sheet.getBoundingClientRect().height }
      : objectSurface(sheet, objectId)
    const { source } = surface
    const width = Math.ceil(surface.width * scale), height = Math.ceil(surface.height * scale)
    if (width > 32767 || height > 32767 || width * height > 32_000_000) throw new Error(tooLarge)
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

    const copy = surface.copy ?? source.cloneNode(true) as HTMLElement
    copy.style.cssText += ';margin:0;transform:none;box-shadow:none;border-color:transparent;overflow:hidden'
    // Freeze animated images and embed raster pixels, including SVG source images.
    const images = [...source.querySelectorAll('img')]
    for (const [index, image] of [...copy.querySelectorAll('img')].entries()) {
      const original = images[index], raster = document.createElement('canvas')
      raster.width = Math.max(1, Math.ceil(original.getBoundingClientRect().width * scale))
      raster.height = Math.max(1, Math.ceil(original.getBoundingClientRect().height * scale))
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
    // Scale rasterization, not document layout or a previously rendered bitmap.
    svg.setAttribute('viewBox', `0 0 ${width / scale} ${height / scale}`)
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
