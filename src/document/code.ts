export const codeLanguages = [
  { label: 'Plain text', value: 'plaintext' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'Python', value: 'python' },
  { label: 'JSON', value: 'json' },
  { label: 'HTML', value: 'html' },
  { label: 'CSS', value: 'css' },
  { label: 'Shell', value: 'shell' },
  { label: 'SQL', value: 'sql' },
] as const

export type CodeLanguage = typeof codeLanguages[number]['value']
export type CodeTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'builtin' | 'property' | 'attribute' | 'tag' | 'operator'
export interface CodeToken { text: string; kind?: CodeTokenKind }

const aliases: Record<string, CodeLanguage> = {
  plaintext: 'plaintext', plain: 'plaintext', text: 'plaintext',
  javascript: 'javascript', js: 'javascript',
  typescript: 'typescript', ts: 'typescript',
  python: 'python', py: 'python',
  json: 'json', html: 'html', css: 'css',
  shell: 'shell', bash: 'shell', sh: 'shell',
  sql: 'sql',
}

const keywords: Record<Exclude<CodeLanguage, 'plaintext'>, Set<string>> = {
  javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'.split(' ')),
  typescript: new Set('abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let module namespace never new number object of package private protected public readonly require return satisfies set static string super switch symbol this throw try type typeof undefined unique unknown var void while with yield'.split(' ')),
  python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'.split(' ')),
  json: new Set(['true', 'false', 'null']),
  html: new Set(),
  css: new Set('important media supports layer container keyframes from to and or not only screen print var calc min max clamp url rgb rgba hsl hsla inherit initial unset revert none auto block inline flex grid absolute relative fixed sticky transparent currentColor'.split(' ')),
  shell: new Set('if then else elif fi case esac for select while until do done in function time coproc return exit break continue shift local declare typeset export readonly unset set eval source alias unalias trap wait'.split(' ')),
  sql: new Set('add all alter and as asc between by case cast check column constraint create cross current_date current_time current_timestamp database default delete desc distinct drop else end escape except exists fetch first for foreign from full grant group having in index inner insert intersect into is join key left like limit not null offset on or order outer primary references return revoke right rollback row rows schema select set table then to transaction union unique update using values view when where with'.split(' ')),
}

const typeNames = new Set('Array BigInt Boolean Date Error Function Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol WeakMap WeakSet'.split(' '))
const pythonBuiltins = new Set('abs all any bin bool bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip'.split(' '))
const wordPattern = /[\p{ID_Start}_$][\p{ID_Continue}$]*/uy
const numberPattern = /(?:0[xX][\da-fA-F]+n?|0[bB][01]+n?|0[oO][0-7]+n?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?n?)/y

export function normalizeCodeLanguage(language: string): CodeLanguage | undefined {
  const key = language.trim().toLowerCase()
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined
}

function matchAt(pattern: RegExp, source: string, index: number) {
  pattern.lastIndex = index
  return pattern.exec(source)
}

function quotedEnd(source: string, start: number, quote: string, triple = false): number {
  const delimiter = triple ? quote.repeat(3) : quote
  let index = start + delimiter.length
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue }
    if (source.startsWith(delimiter, index)) return index + delimiter.length
    if (!triple && quote !== '`' && source[index] === '\n') return index
    index++
  }
  return source.length
}

export function highlightCode(source: string, language: string): CodeToken[] {
  const lang = normalizeCodeLanguage(language)
  if (!lang || lang === 'plaintext' || !source) return source ? [{ text: source }] : []

  const tokens: CodeToken[] = []
  let index = 0
  let pendingName: 'function' | 'type' | undefined
  const emit = (text: string, kind?: CodeTokenKind) => {
    if (!text) return
    const last = tokens.at(-1)
    if (last && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }
  const lineComment = lang === 'javascript' || lang === 'typescript' ? '//' : lang === 'python' || lang === 'shell' ? '#' : lang === 'sql' ? '--' : ''
  const blockComment = lang === 'javascript' || lang === 'typescript' || lang === 'css' || lang === 'sql'
  const keywordSet = keywords[lang]

  while (index < source.length) {
    const start = index
    const char = source[index]

    if (lang === 'html' && source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      index = end < 0 ? source.length : end + 3
      emit(source.slice(start, index), 'comment')
      continue
    }
    if (lang === 'html' && char === '<' && /[\w/!?]/.test(source[index + 1] ?? '')) {
      index++
      if (source[index] === '/') index++
      if (source[index] === '!') {
        const end = source.indexOf('>', index)
        index = end < 0 ? source.length : end + 1
        emit(source.slice(start, index), 'keyword')
        continue
      }
      emit(source.slice(start, index))
      const tag = matchAt(/[\w:-]+/y, source, index)
      if (tag) { emit(tag[0], 'tag'); index += tag[0].length }
      while (index < source.length) {
        if (source[index] === '>') { emit('>'); index++; break }
        if (source[index] === '/' && source[index + 1] === '>') { emit('/>'); index += 2; break }
        if (/\s/.test(source[index])) { emit(source[index++]); continue }
        if (source[index] === '=') { emit('=', 'operator'); index++; continue }
        if (source[index] === '"' || source[index] === "'") {
          const end = quotedEnd(source, index, source[index])
          emit(source.slice(index, end), 'string'); index = end; continue
        }
        const attribute = source.slice(index).match(/^[^\s=/>]+/)?.[0]
        if (attribute) { emit(attribute, 'attribute'); index += attribute.length }
        else { emit(source[index++]) }
      }
      continue
    }

    if (lineComment && source.startsWith(lineComment, index)) {
      const end = source.indexOf('\n', index)
      index = end < 0 ? source.length : end
      emit(source.slice(start, index), 'comment')
      continue
    }
    if (blockComment && source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      emit(source.slice(start, index), 'comment')
      continue
    }

    if (lang === 'shell' && char === '$') {
      const variable = source.slice(index).match(/^\$(?:\{[^}\n]*\}|[A-Za-z_][\w]*|[0-9@?#$!*-])/)?.[0]
      if (variable) { emit(variable, 'builtin'); index += variable.length; continue }
    }

    if (char === '"' || char === "'" || (lang === 'javascript' || lang === 'typescript') && char === '`') {
      const triple = lang === 'python' && source.startsWith(char.repeat(3), index)
      const end = quotedEnd(source, index, char, triple)
      const value = source.slice(index, end)
      const key = lang === 'json' && source.slice(end).match(/^\s*:/)
      emit(value, key ? 'property' : 'string')
      index = end
      continue
    }

    const number = (char >= '0' && char <= '9' || char === '.' && /\d/.test(source[index + 1] ?? '')) ? matchAt(numberPattern, source, index) : null
    if (number) { emit(number[0], 'number'); index += number[0].length; pendingName = undefined; continue }

    const customProperty = lang === 'css' && source.startsWith('--', index) ? source.slice(index).match(/^--[\w-]+/) : null
    const word = customProperty ?? matchAt(wordPattern, source, index)
    if (word) {
      const value = word[0]
      const after = source.slice(index + value.length).match(/^\s*/)?.[0].length ?? 0
      const next = source[index + value.length + after]
      let kind: CodeTokenKind | undefined
      if (lang === 'json' && keywordSet.has(value)) kind = 'keyword'
      else if (pendingName) { kind = pendingName; pendingName = undefined }
      else if (keywordSet.has(value) || lang === 'sql' && keywordSet.has(value.toLowerCase()) || lang === 'css' && keywordSet.has(value.toLowerCase())) kind = 'keyword'
      else if ((lang === 'javascript' || lang === 'typescript') && ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(value)) kind = 'builtin'
      else if ((lang === 'javascript' || lang === 'typescript') && typeNames.has(value)) kind = 'type'
      else if (lang === 'python' && pythonBuiltins.has(value)) kind = 'builtin'
      else if (value === 'console' || value === 'window' || value === 'document' || value === 'process' || value === 'require') kind = 'builtin'
      else if (lang === 'css' && next === ':') kind = 'property'
      else if (next === '(') kind = 'function'
      emit(value, kind)
      index += value.length
      if (kind === 'keyword') {
        if (value === 'function' || value === 'def') pendingName = 'function'
        else if (value === 'class' || value === 'interface' || value === 'type' || value === 'enum') pendingName = 'type'
      }
      continue
    }

    if ('=+-*/%<>!&|^~?:'.includes(char)) {
      let end = index + 1
      while (end < source.length && '=+-*/%<>!&|^~?:'.includes(source[end])) end++
      emit(source.slice(index, end), 'operator')
      index = end
      if (!/\s/.test(char)) pendingName = undefined
      continue
    }

    emit(char)
    if (!/\s/.test(char)) pendingName = undefined
    index++
  }
  return tokens
}
