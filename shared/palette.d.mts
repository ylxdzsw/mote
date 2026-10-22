export interface PaletteTheme { mode: 'light' | 'dark'; hue: number; secondaryHue: number }
export interface PaletteEntry { id: string; name: string; strong: string; soft?: string }
export const defaultHue: number
export const defaultSecondaryHue: number
export const neutralIds: readonly string[]
export function mixHex(from: string, to: string, amount: number): string
export function contrastRatio(first: string, second: string): number
export function oklchHex(lightness: number, chroma: number, hue: number): string
export function validPaletteReference(value: unknown): boolean
export function pageColor(theme: PaletteTheme): string
export function paletteEntries(theme: PaletteTheme): PaletteEntry[]
export const boxColorIds: string[]
