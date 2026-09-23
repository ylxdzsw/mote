import type { CSSProperties } from 'react'
import type { Theme } from '../document/model'
import { contrastRatio, mixHex, primaryEntry } from './colors'
import { paletteColor } from './palette'

// Keep the author's color if it works; otherwise find the nearest safe mix.
function toward(from: string, to: string, readable: (color: string) => boolean) {
  if (readable(from)) return from
  let low = 0, high = 1
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2
    if (readable(mixHex(from, to, middle))) high = middle
    else low = middle
  }
  return mixHex(from, to, high)
}

function segmentCursor(accent: string) {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cpath d='M3 3h5l9 7-9 7H3l7-7z' fill='%23${accent.slice(1)}' stroke='white' stroke-width='1' stroke-linejoin='round'/%3E%3C/svg%3E") 17 10, default`
}

export function uiThemeVariables(theme: Theme): CSSProperties {
  const primary = primaryEntry(theme.hue)
  const page = paletteColor(theme, theme.defaults.background)
  const subtle = paletteColor(theme, 'subtle')
  const endpoint = contrastRatio('#000000', page) >= contrastRatio('#ffffff', page) ? '#000000' : '#ffffff'
  const readable = (color: string, backgrounds: string[]) => toward(color, endpoint, value => backgrounds.every(bg => contrastRatio(value, bg) >= 4.5))
  // Extreme Subtle/Soft edits must not turn a control into an unreadable island.
  const surfaceContrast = Math.min(7, contrastRatio(endpoint, page))
  const surface = (color: string) => toward(color, page, bg => contrastRatio(endpoint, bg) >= surfaceContrast)
  const secondary = surface(subtle), hover = surface(mixHex(subtle, paletteColor(theme, 'ink'), .08))
  const dark = endpoint === '#ffffff'
  const soft = surface(dark ? mixHex(page, primary.soft, .08) : primary.soft)
  const selected = surface(dark ? mixHex(page, primary.soft, .14) : mixHex(primary.soft, primary.strong, .12))
  const errorSurface = surface(dark ? mixHex(page, '#984b38', .15) : '#f7e9df')
  const dangerSurface = surface(dark ? mixHex(page, '#984b38', .1) : '#fff8f4')
  const ansi = { black: '#526052', red: '#a33430', green: '#38633c', yellow: '#806016', blue: '#345d9a', magenta: '#83517d', cyan: '#287278', white: '#526052' }
  const ansiSurfaces = Object.values(ansi).map(color => surface(mixHex(page, color, .12)))
  const backgrounds = [page, secondary, hover, soft, selected, errorSurface, dangerSurface, ...ansiSurfaces]
  const ink = readable(paletteColor(theme, 'ink'), backgrounds)
  const muted = readable(paletteColor(theme, 'muted'), backgrounds)
  const accent = readable(primary.strong, backgrounds)
  const accentHover = mixHex(accent, endpoint, .12)
  const onAccent = toward(page, endpoint === '#000000' ? '#ffffff' : '#000000', color => [accent, accentHover].every(bg => contrastRatio(color, bg) >= 4.5))
  const status = {
    'success': '#749469', 'success-strong': '#477448', 'success-muted': '#688064',
    'warning': '#b5994e', 'warning-text': '#a14d3e',
    'error': '#9f4533', 'error-text': '#984b38', 'error-strong': '#873e29', 'error-math': '#a33f32',
    'danger-action': '#955244', 'danger-text': '#68463d', 'danger-muted': '#806b64',
  }

  return {
    colorScheme: dark ? 'dark' : 'light',
    '--ui-hue': String(theme.hue),
    '--ui-shell': page,
    '--ui-surface': page,
    '--ui-surface-raised': page,
    '--ui-surface-muted': secondary,
    '--ui-surface-hover': hover,
    '--ui-ink': ink,
    '--ui-ink-strong': ink,
    '--ui-muted': muted,
    '--ui-faint': muted,
    '--ui-border': mixHex(subtle, ink, .2),
    '--ui-border-strong': toward(subtle, endpoint, color => contrastRatio(color, page) >= 3),
    '--ui-page-border': mixHex(subtle, ink, .2),
    '--ui-grid': muted,
    '--ui-accent': accent,
    '--ui-accent-hover': accentHover,
    '--ui-accent-border': toward(primary.strong, endpoint, color => contrastRatio(color, page) >= 3),
    '--ui-accent-soft': soft,
    '--ui-accent-surface': selected,
    '--ui-on-accent': onAccent,
    '--ui-accent-tint': `color-mix(in srgb, ${accent} 14%, transparent)`,
    '--ui-accent-tint-strong': `color-mix(in srgb, ${accent} 22%, transparent)`,
    '--ui-shadow-soft': `color-mix(in srgb, ${ink} 7%, transparent)`,
    '--ui-shadow': `color-mix(in srgb, ${ink} 12%, transparent)`,
    '--ui-shadow-strong': `color-mix(in srgb, ${ink} 20%, transparent)`,
    '--ui-backdrop': `color-mix(in srgb, ${ink} 28%, transparent)`,
    '--ui-error-surface': errorSurface,
    '--ui-danger-surface': dangerSurface,
    '--ui-error-border': readable('#b87160', backgrounds),
    '--ui-danger-border': readable('#cda69a', backgrounds),
    ...Object.fromEntries(Object.entries(status).map(([role, color]) => [`--ui-${role}`, readable(color, backgrounds)])),
    ...Object.fromEntries(Object.entries(ansi).flatMap(([name, color], index) => [
      [`--ui-ansi-${name}`, readable(color, backgrounds)], [`--ui-ansi-${name}-bg`, ansiSurfaces[index]],
    ])),
    '--ui-segment-cursor': segmentCursor(accent),
    '--accent': 'var(--ui-accent)',
    '--muted': 'var(--ui-muted)',
    '--border': 'var(--ui-border)',
  } as CSSProperties
}
