import type { CSSProperties } from 'react'
import { oklchHex, primaryEntry } from './colors'

function segmentCursor(accent: string) {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cpath d='M3 3h5l9 7-9 7H3l7-7z' fill='%23${accent.slice(1)}' stroke='white' stroke-width='1' stroke-linejoin='round'/%3E%3C/svg%3E") 17 10, default`
}

export function uiThemeVariables(hue: number): CSSProperties {
  const primary = primaryEntry(hue)
  const color = (lightness: number, chroma: number) => oklchHex(lightness, chroma, hue)
  const ink = color(.29, .018)

  return {
    '--ui-hue': String(hue),
    '--ui-ink': ink,
    '--ui-ink-strong': color(.245, .02),
    '--ui-muted': color(.49, .018),
    '--ui-faint': color(.52, .014),
    '--ui-shell': color(.94, .012),
    '--ui-surface': color(.975, .012),
    '--ui-surface-raised': color(.99, .008),
    '--ui-surface-muted': color(.94, .015),
    '--ui-surface-hover': color(.925, .022),
    '--ui-border': color(.86, .018),
    '--ui-border-strong': color(.72, .03),
    '--ui-page-border': color(.84, .015),
    '--ui-grid': color(.64, .03),
    '--ui-accent': primary.strong,
    '--ui-accent-hover': color(.37, .095),
    '--ui-accent-border': color(.69, .055),
    '--ui-accent-soft': primary.soft,
    '--ui-accent-surface': color(.89, .04),
    '--ui-accent-tint': `color-mix(in srgb, ${primary.strong} 14%, transparent)`,
    '--ui-accent-tint-strong': `color-mix(in srgb, ${primary.strong} 22%, transparent)`,
    '--ui-shadow-soft': `color-mix(in srgb, ${ink} 7%, transparent)`,
    '--ui-shadow': `color-mix(in srgb, ${ink} 12%, transparent)`,
    '--ui-shadow-strong': `color-mix(in srgb, ${ink} 20%, transparent)`,
    '--ui-backdrop': `color-mix(in srgb, ${ink} 28%, transparent)`,
    '--ui-segment-cursor': segmentCursor(primary.strong),
    '--accent': 'var(--ui-accent)',
    '--muted': 'var(--ui-muted)',
    '--border': 'var(--ui-border)',
  } as CSSProperties
}
