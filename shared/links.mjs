const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const HTTP_PREFIX = /^https?:\/\//i

function parseAbsoluteHttp(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value || CONTROL.test(value) || value.includes('\\')) return null
  const match = /^(https?):\/\/([^/?#]+)/i.exec(value)
  if (!match || match[2].includes('@')) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

function validDomain(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.')) return false
  return host.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

function isBareDomain(value) {
  if (!value || /^[/?#]/.test(value) || value.startsWith('//') || value.includes('\\')) return false
  const authority = value.split(/[/?#]/, 1)[0]
  if (!authority || authority.includes('@')) return false
  const colon = authority.lastIndexOf(':')
  if (colon !== -1 && !/^\d+$/.test(authority.slice(colon + 1))) return false
  const url = parseAbsoluteHttp(`https://${value}`)
  return Boolean(url && validDomain(url.hostname))
}

export function validLinkHref(value) {
  return typeof value === 'string' && HTTP_PREFIX.test(value) && parseAbsoluteHttp(value) !== null
}

export function normalizeLinkHref(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const absolute = HTTP_PREFIX.test(trimmed) ? trimmed : isBareDomain(trimmed) ? `https://${trimmed}` : null
  return absolute === null ? null : parseAbsoluteHttp(absolute)?.href ?? null
}
