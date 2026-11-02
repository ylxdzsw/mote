import { HighlightStyle } from '@codemirror/language'
import type { Language } from '@codemirror/language'
import { highlightTree, tags } from '@lezer/highlight'
import { normalizeCodeLanguage, type CodeLanguage, type CodeToken, type CodeTokenKind } from '../document/code'

type ParsedLanguage = Exclude<CodeLanguage, 'plaintext'>
type LanguageLoader = () => Promise<Language>

const languageLoaders: Record<ParsedLanguage, LanguageLoader> = {
  c: async () => (await import('./languages/c')).default,
  css: async () => (await import('./languages/css')).default,
  html: async () => (await import('./languages/html')).default,
  javascript: async () => (await import('./languages/javascript')).default,
  python: async () => (await import('./languages/python')).default,
  rust: async () => (await import('./languages/rust')).default,
  shell: async () => (await import('./languages/shell')).default,
  sql: async () => (await import('./languages/sql')).default,
}

const resolvedLanguages = new Map<ParsedLanguage, Language>()
const languagePromises = new Map<ParsedLanguage, Promise<Language>>()

export function getCodeLanguage(id: string): Language | null {
  const language = normalizeCodeLanguage(id)
  return language && language !== 'plaintext' ? resolvedLanguages.get(language) ?? null : null
}

export function loadCodeLanguage(id: string): Promise<Language | null> {
  const language = normalizeCodeLanguage(id)
  if (!language || language === 'plaintext') return Promise.resolve(null)

  const resolved = resolvedLanguages.get(language)
  if (resolved) return Promise.resolve(resolved)

  let pending = languagePromises.get(language)
  if (!pending) {
    pending = languageLoaders[language]().then(loaded => {
      resolvedLanguages.set(language, loaded)
      return loaded
    }).catch(error => {
      languagePromises.delete(language)
      throw error
    })
    languagePromises.set(language, pending)
  }
  return pending
}

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'code-token code-comment' },
  { tag: [tags.string, tags.character, tags.regexp], class: 'code-token code-string' },
  { tag: tags.number, class: 'code-token code-number' },
  { tag: tags.keyword, class: 'code-token code-keyword' },
  { tag: tags.operator, class: 'code-token code-operator' },
  { tag: [tags.typeName, tags.className], class: 'code-token code-type' },
  { tag: [tags.standard(tags.name), tags.special(tags.name), tags.self, tags.null, tags.bool, tags.atom], class: 'code-token code-builtin' },
  { tag: tags.propertyName, class: 'code-token code-property' },
  { tag: tags.attributeName, class: 'code-token code-attribute' },
  { tag: tags.tagName, class: 'code-token code-tag' },
  { tag: tags.function(tags.name), class: 'code-token code-function' },
])

const tokenKinds: readonly CodeTokenKind[] = ['keyword', 'string', 'number', 'comment', 'function', 'type', 'builtin', 'property', 'attribute', 'tag', 'operator']

function kindFor(classes: string): CodeTokenKind | undefined {
  const classNames = new Set(classes.split(/\s+/))
  return tokenKinds.find(kind => classNames.has(`code-${kind}`))
}

export function highlightCode(source: string, language: Language | null): CodeToken[] {
  if (!source) return []
  if (!language) return [{ text: source }]

  const tokens: CodeToken[] = []
  const emit = (from: number, to: number, kind?: CodeTokenKind) => {
    if (to <= from) return
    const text = source.slice(from, to)
    const previous = tokens.at(-1)
    if (previous && previous.kind === kind) previous.text += text
    else tokens.push({ text, kind })
  }

  let offset = 0
  const tree = language.parser.parse(source)
  highlightTree(tree, codeHighlightStyle, (from, to, classes) => {
    const start = Math.max(offset, from)
    const end = Math.min(source.length, to)
    if (start > offset) emit(offset, start)
    if (end > start) emit(start, end, kindFor(classes))
    offset = Math.max(offset, end)
  })
  if (offset < source.length) emit(offset, source.length)
  return tokens
}
