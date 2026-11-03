import { useState } from 'react'
import { validPaletteReference } from '../../shared/palette.mjs'

type Slot = { id: string; used: number }

const initialSlots = (): Slot[] => ['primary', 'secondary', 'red'].map(id => ({ id, used: 0 }))

export function useRecentColors(documentId: string) {
  const [state, setState] = useState(() => ({ documentId, slots: initialSlots() }))
  let slots = state.slots
  if (state.documentId !== documentId) {
    slots = initialSlots()
    setState({ documentId, slots })
  }
  const remember = (id: string) => setState(current => {
    if (!validPaletteReference(id)) return current
    const slots = [...(current.documentId === documentId ? current.slots : initialSlots())]
    const used = Math.max(0, ...slots.map(slot => slot.used)) + 1
    const existing = slots.findIndex(slot => slot.id === id)
    const oldest = Math.min(...slots.map(slot => slot.used))
    const index = existing >= 0 ? existing : slots.findIndex(slot => slot.used === oldest)
    slots[index] = { id, used }
    return { documentId, slots }
  })
  return { colors: slots.map(slot => slot.id), remember }
}
