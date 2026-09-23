export const defaultHue = 145

function channels(hex: string) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
}

export function mixHex(from: string, to: string, amount: number) {
  const target = channels(to)
  return `#${channels(from).map((value, index) => Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`
}

export function contrastRatio(first: string, second: string) {
  const luminance = (hex: string) => channels(hex).reduce((sum, channel, index) => {
    const value = channel / 255
    return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
  }, 0)
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

// Reduce chroma at fixed perceived lightness/hue to stay inside sRGB.
export function oklchHex(lightness: number, chroma: number, hue: number): string {
  const angle = hue * Math.PI / 180
  const rgb = (c: number) => {
    const a = c * Math.cos(angle), b = c * Math.sin(angle)
    const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3
    const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3
    const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3
    return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
      -.0041960863 * l - .7034186147 * m + 1.707614701 * s]
  }
  const inGamut = (channels: number[]) => channels.every(value => value >= 0 && value <= 1)
  let channels = rgb(chroma)
  if (!inGamut(channels)) {
    let low = 0, high = chroma
    for (let i = 0; i < 16; i++) {
      const mid = (low + high) / 2
      if (inGamut(rgb(mid))) low = mid
      else high = mid
    }
    channels = rgb(low)
  }
  return `#${channels.map(value => {
    const srgb = value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055
    return Math.round(Math.max(0, Math.min(1, srgb)) * 255).toString(16).padStart(2, '0')
  }).join('')}`
}

export function primaryEntry(hue: number) {
  return { id: 'primary', name: 'Primary', strong: oklchHex(.43, .09, hue), soft: oklchHex(.95, .025, hue) }
}
