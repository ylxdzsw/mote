import type { FloatingHTMLWidget } from '../document/model'

export function aiPlaceholder(base: { id: string; anchorId: string | null; x: number; y: number; width: number; textFlow: 'overlap' | 'repel' }): FloatingHTMLWidget {
  return { ...base, kind: 'html', height: 220, alt: 'AI generation area', html: '<div style="font:14px system-ui;color:#687166;padding:16px">AI generation area</div>',
    screenshot: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="340" height="220"><rect width="100%" height="100%" fill="#e9efdf"/><text x="16" y="32" font-family="sans-serif" font-size="14" fill="#687166">AI generation area</text></svg>')}` }
}
