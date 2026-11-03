import type { Theme } from '../document/model'
import { paletteEntries } from '../../shared/palette.mjs'
export { paletteEntries, pageColor, neutralIds, boxColorIds, hueTones } from '../../shared/palette.mjs'

export function paletteColor(theme: Theme, reference: string): string {
  const [id, tone] = reference.split(':')
  const entry = paletteEntries(theme).find(entry => entry.id === id)!
  return tone === 'soft' ? entry.soft! : entry.strong
}
export function paletteCSS(reference: string): string {
  return `var(--palette-${reference.replace(':', '-')})`
}
export function paletteSwatches(theme: Theme) {
  return paletteEntries(theme).flatMap(entry => [
    { value: entry.id, label: entry.soft ? `${entry.name} · Strong` : entry.name, color: entry.strong },
    ...(entry.soft ? [{ value: `${entry.id}:soft`, label: `${entry.name} · Soft`, color: entry.soft }] : []),
  ])
}
