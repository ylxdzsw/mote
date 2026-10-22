import { useState } from 'react'
import type { Theme } from '../document/model'
import { neutralIds, paletteEntries, paletteSwatches } from '../theme/palette'

type Slot = { id: string; used: number }

function reconcile(slots: Slot[], theme: Theme) {
  const entries = paletteEntries(theme)
  const valid = new Set(paletteSwatches(theme).map(swatch => swatch.value))
  const next = slots.map(slot => valid.has(slot.id) ? slot : null)
  for (const entry of entries.filter(entry => !(neutralIds as readonly string[]).includes(entry.id))) {
    if (next.some(slot => slot?.id === entry.id)) continue
    const empty = next.indexOf(null)
    if (empty >= 0) next[empty] = { id: entry.id, used: 0 }
    else if (next.length < 3) next.push({ id: entry.id, used: 0 })
  }
  return next.filter((slot): slot is Slot => slot !== null)
}

export function useRecentColors(documentId: string, theme: Theme) {
  const [state, setState] = useState(() => ({ documentId, slots: reconcile([], theme) }))
  let slots = state.slots
  if (state.documentId !== documentId) {
    slots = reconcile([], theme)
    setState({ documentId, slots })
  }
  const remember = (id: string) => setState(current => {
    const valid = new Set(paletteSwatches(theme).map(swatch => swatch.value))
    if (!valid.has(id)) return current
    const slots = [...(current.documentId === documentId ? current.slots : reconcile([], theme))]
    const used = Math.max(0, ...slots.map(slot => slot.used)) + 1
    const existing = slots.findIndex(slot => slot.id === id)
    const index = existing >= 0 ? existing : slots.length < 3 ? slots.length
      : slots.findIndex(slot => slot.used === Math.min(...slots.map(slot => slot.used)))
    slots[index] = { id, used }
    return { documentId, slots }
  })
  return { colors: slots.map(slot => slot.id), remember }
}
