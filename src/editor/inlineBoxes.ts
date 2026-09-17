let measure: CanvasRenderingContext2D | null = null

// The decoration's zero-sized inline box sits on the text baseline. Its padding
// follows ink metrics; the inner span alone participates in normal text layout.
export function fitInlineBoxes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-inline-decoration="box"]').forEach(fitInlineBox)
}

export function fitInlineBox(box: HTMLElement) {
  measure ??= document.createElement('canvas').getContext('2d')!
  let ascent = 0, descent = 0
  const text = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    const style = getComputedStyle(node.parentElement!)
    measure.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const ink = measure.measureText(node.textContent!)
    ascent = Math.max(ascent, ink.actualBoundingBoxAscent)
    descent = Math.max(descent, ink.actualBoundingBoxDescent)
  }
  if (!ascent && !descent) return
  for (const [edge, value] of [['ascent', ascent], ['descent', descent]] as const) {
    const pixels = `${value}px`
    if (box.style.getPropertyValue(`--box-${edge}`) !== pixels) box.style.setProperty(`--box-${edge}`, pixels)
  }
}
