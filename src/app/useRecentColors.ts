import { useState } from 'react'
import type { Theme } from '../document/model'
import { neutralIds, paletteEntries } from '../theme/palette'

type Slot = { id: string; used: number }

function reconcile(slots: Slot[], theme: Theme) {
  const entries = paletteEntries(theme)
  const valid = new Set(entries.filter(entry => entry.id !== 'paper').map(entry => entry.id))
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
  const paletteKey = JSON.stringify([documentId, theme.palette.map(entry => entry.id)])
  const [state, setState] = useState(() => ({ documentId, paletteKey, slots: reconcile([], theme) }))
  let slots = state.slots
  if (state.paletteKey !== paletteKey) {
    slots = reconcile(state.documentId === documentId ? slots : [], theme)
    setState({ documentId, paletteKey, slots })
  }
  const remember = (id: string) => setState(current => {
    const slots = [...current.slots]
    const used = Math.max(0, ...slots.map(slot => slot.used)) + 1
    const existing = slots.findIndex(slot => slot.id === id)
    const index = existing >= 0 ? existing : slots.length < 3 ? slots.length
      : slots.findIndex(slot => slot.used === Math.min(...slots.map(slot => slot.used)))
    slots[index] = { id, used }
    return { ...current, slots }
  })
  return { colors: slots.map(slot => slot.id), remember }
}
