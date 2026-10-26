import type { FloatingHTMLWidget, ObjectLayout } from '../document/model'

export function aiPlaceholder(base: { id: string; layout: ObjectLayout }): FloatingHTMLWidget {
  return { ...base, kind: 'html', layout: { ...base.layout, height: 220 }, alt: 'AI generation area', html: '',
    screenshot: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="220"/>')}` }
}
