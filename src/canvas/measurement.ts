// Computed box dimensions stay in document pixels, independent of view transforms.
export function nativeSize(element: HTMLElement) {
  const style = getComputedStyle(element)
  const extra = (...names: string[]) => style.boxSizing === 'border-box' ? 0 : names.reduce((sum, name) => sum + parseFloat(style.getPropertyValue(name)), 0)
  return {
    width: parseFloat(style.width) + extra('padding-left', 'padding-right', 'border-left-width', 'border-right-width'),
    height: parseFloat(style.height) + extra('padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width'),
  }
}
