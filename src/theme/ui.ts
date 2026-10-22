import type { CSSProperties } from 'react'
import type { Theme } from '../document/model'
import { contrastRatio, mixHex, oklchHex } from './colors'
import { pageColor } from './palette'

// Keep tonal roles readable across normal, hovered, and selected surfaces.
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

export function uiThemeVariables(theme: Theme, language: 'en' | 'zh-Hans' = 'en'): CSSProperties {
  const page = pageColor(theme)
  const dark = theme.mode === 'dark'
  const endpoint = dark ? '#ffffff' : '#000000'
  const tone = (light: number, night: number, chroma: number) => oklchHex(dark ? night : light, chroma, theme.hue)
  const readable = (color: string, backgrounds: string[]) => toward(color, endpoint, value => backgrounds.every(bg => contrastRatio(value, bg) >= 4.5))
  // Main chrome shares the page background; control tones still follow the hue.
  const panel = page, raised = dark ? tone(1, .24, .004) : '#ffffff'
  const secondary = tone(.963, .26, .006), hover = tone(.93, .305, .009)
  const soft = tone(.96, .275, .02), selected = tone(.915, .32, .035)
  // All sides of the canvas use the same achromatic surround.
  const canvas = dark ? '#171717' : '#eeeeee'
  const workspaceHover = dark ? '#3b3b3b' : '#d2d2d2'
  const workspaceInk = dark ? '#bdbdbd' : '#555555'
  const workspaceBorder = dark ? '#494949' : '#c4c4c4'
  const errorSurface = dark ? '#362623' : '#fbeee8'
  const dangerSurface = dark ? '#302322' : '#fff5f0'
  const ansi = { black: '#526052', red: '#a33430', green: '#38633c', yellow: '#806016', blue: '#345d9a', magenta: '#83517d', cyan: '#287278', white: '#526052' }
  const ansiSurfaces = Object.values(ansi).map(color => mixHex(raised, color, .12))
  const backgrounds = [panel, raised, secondary, hover, soft, selected, errorSurface, dangerSurface, ...ansiSurfaces]
  const ink = readable(tone(.25, .94, .01), backgrounds)
  const muted = readable(tone(.46, .74, .008), backgrounds)
  const accent = readable(tone(.44, .77, .1), backgrounds)
  const accentHover = mixHex(accent, endpoint, .12)
  const onAccent = dark ? '#161616' : '#ffffff'
  const border = tone(.84, .37, .008)
  const borderStrong = toward(tone(.6, .59, .008), endpoint, color => [panel, raised, secondary, hover].every(bg => contrastRatio(color, bg) >= 3))
  const status = {
    'success': '#749469', 'success-strong': '#477448', 'success-muted': '#688064',
    'warning': '#b5994e', 'warning-text': '#a14d3e',
    'error': '#9f4533', 'error-text': '#984b38', 'error-strong': '#873e29', 'error-math': '#a33f32',
    'danger-action': '#955244', 'danger-text': '#68463d', 'danger-muted': '#806b64',
  }

  return {
    colorScheme: dark ? 'dark' : 'light',
    '--ui-hue': String(theme.hue),
    '--ui-shell': canvas,
    '--ui-canvas': canvas,
    '--ui-gutter': canvas,
    '--ui-minimap': page,
    '--ui-workspace-hover': workspaceHover,
    '--ui-workspace-ink': workspaceInk,
    '--ui-workspace-border': workspaceBorder,
    '--ui-surface': panel,
    '--ui-surface-raised': raised,
    '--ui-surface-muted': secondary,
    '--ui-surface-hover': hover,
    '--ui-ink': ink,
    '--ui-ink-strong': ink,
    '--ui-muted': muted,
    '--ui-faint': muted,
    '--ui-border': border,
    '--ui-border-strong': borderStrong,
    '--ui-page-border': workspaceBorder,
    '--ui-grid': workspaceInk,
    '--ui-accent': accent,
    '--ui-accent-hover': accentHover,
    '--ui-accent-border': accent,
    '--ui-accent-soft': soft,
    '--ui-accent-surface': selected,
    '--ui-on-accent': onAccent,
    '--ui-accent-tint': `color-mix(in srgb, ${accent} 14%, transparent)`,
    '--ui-accent-tint-strong': `color-mix(in srgb, ${accent} 22%, transparent)`,
    '--ui-shadow-soft': dark ? '#00000030' : '#0000000d',
    '--ui-shadow': dark ? '#00000050' : '#0000001f',
    '--ui-shadow-strong': dark ? '#00000080' : '#00000033',
    '--ui-backdrop': dark ? '#00000099' : '#00000047',
    '--ui-error-surface': errorSurface,
    '--ui-danger-surface': dangerSurface,
    '--ui-error-border': readable('#b87160', backgrounds),
    '--ui-danger-border': readable('#cda69a', backgrounds),
    ...Object.fromEntries(Object.entries(status).map(([role, color]) => [`--ui-${role}`, readable(color, backgrounds)])),
    ...Object.fromEntries(Object.entries(ansi).flatMap(([name, color], index) => [
      [`--ui-ansi-${name}`, readable(color, backgrounds)], [`--ui-ansi-${name}-bg`, ansiSurfaces[index]],
    ])),
    '--ui-font-family': language === 'zh-Hans'
      ? '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", Inter, ui-sans-serif, system-ui, sans-serif'
      : 'Inter, ui-sans-serif, system-ui, sans-serif',
    '--ui-segment-cursor': segmentCursor(accent),
    '--accent': 'var(--ui-accent)',
    '--muted': 'var(--ui-muted)',
    '--border': 'var(--ui-border)',
  } as CSSProperties
}
