// Closest belt hues to Huawei Red (#C7000B) and IBM Blue (#0F62FE) in Light.
export const defaultHue = 29
export const defaultSecondaryHue = 262

function channels(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
}

export function mixHex(from, to, amount) {
  const target = channels(to)
  return `#${channels(from).map((value, index) => Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`
}

export function contrastRatio(first, second) {
  const luminance = (hex) => channels(hex).reduce((sum, channel, index) => {
    const value = channel / 255
    return sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index]
  }, 0)
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

function linearRgb(lightness, chroma, hue) {
  const angle = hue * Math.PI / 180, a = chroma * Math.cos(angle), b = chroma * Math.sin(angle)
  const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3
  const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3
  const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s]
}

// Largest sRGB chroma at this OKLCH lightness and hue.
function maxChroma(lightness, hue, limit = .4) {
  let low = 0, high = limit
  if (linearRgb(lightness, high, hue).every(value => value >= 0 && value <= 1)) return high
  for (let i = 0; i < 16; i++) {
    const mid = (low + high) / 2
    if (linearRgb(lightness, mid, hue).every(value => value >= 0 && value <= 1)) low = mid
    else high = mid
  }
  return low
}

// Reduce chroma at fixed perceived lightness/hue to stay inside sRGB.
export function oklchHex(lightness, chroma, hue) {
  return `#${linearRgb(lightness, maxChroma(lightness, hue, chroma), hue).map(value => {
    const srgb = value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055
    return Math.round(Math.max(0, Math.min(1, srgb)) * 255).toString(16).padStart(2, '0')
  }).join('')}`
}

// One rule for every hue: fixed lightness per mode, the same share of each hue's
// available sRGB chroma (capped), and a lightness nudge only if Strong would read
// below 4.5:1 on the page. Soft is a light (or deep) background tint.
const tones = {
  light: { page: '#ffffff', lightness: .555, share: .9, cap: .24, soft: [.95, .035] },
  dark: { page: '#181818', lightness: .72, share: .9, cap: .2, soft: [.29, .045] },
}

export function hueTones(mode, hue) {
  const tone = tones[mode], step = mode === 'dark' ? .005 : -.005
  const strongAt = lightness => oklchHex(lightness, Math.min(tone.cap, tone.share * maxChroma(lightness, hue)), hue)
  let lightness = tone.lightness, strong = strongAt(lightness)
  while (contrastRatio(strong, tone.page) < 4.5) strong = strongAt(lightness += step)
  return { strong, soft: oklchHex(...tone.soft, hue) }
}

export const neutralIds = ['gray1', 'gray2', 'gray3', 'gray4', 'gray5', 'gray6']
const fixedHues = { red: 25, amber: 80, green: 145, blue: 255, violet: 305, pink: 350 }
const pairIds = ['primary', 'secondary', ...Object.keys(fixedHues)]
const lightGrays = ['#000000', '#303030', '#666666', '#aaaaaa', '#eeeeee', '#ffffff']
const darkGrays = ['#ffffff', '#e0e0e0', '#aaaaaa', '#666666', '#303030', '#000000']

export function validPaletteReference(value) {
  if (typeof value !== 'string') return false
  return neutralIds.includes(value) || pairIds.some(id => value === id || value === `${id}:soft`)
}

// Text-box decorations pick a Strong/Soft pair; Gray 4/Gray 5 is the only gray pair.
export const boxColorIds = [...pairIds, 'gray4']

export function pageColor(theme) {
  return tones[theme.appearance.mode].page
}

export function paletteEntries(theme) {
  const dark = theme.appearance.mode === 'dark'
  const hues = { primary: theme.appearance.primaryHue, secondary: theme.appearance.secondaryHue, ...fixedHues }
  return [
    ...Object.entries(hues).map(([id, hue]) => ({ id, name: id[0].toUpperCase() + id.slice(1), ...hueTones(theme.appearance.mode, hue) })),
    ...neutralIds.map((id, index) => ({ id, name: `Gray ${index + 1}${index === 0 ? dark ? ' · White' : ' · Black' : index === 5 ? dark ? ' · Black' : ' · White' : ''}`, strong: (dark ? darkGrays : lightGrays)[index] })),
  ]
}
