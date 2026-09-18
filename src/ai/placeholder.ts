import type { FloatingHTMLWidget } from '../document/model'

export function aiPlaceholder(base: { id: string; anchorId: string | null; x: number; y: number; width: number; textFlow: 'overlap' | 'repel' }): FloatingHTMLWidget {
  return { ...base, kind: 'html', height: 220, alt: 'AI generation area', html: '',
    screenshot: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="220"/>')}` }
}
