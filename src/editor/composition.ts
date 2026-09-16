// Some IMEs report the legacy process-key code without isComposing.
export const isComposingKey = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229
