export const codeLanguages = [
  { label: 'Plain text', value: 'plaintext' },
  { label: 'C', value: 'c' },
  { label: 'CSS', value: 'css' },
  { label: 'HTML', value: 'html' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'Python', value: 'python' },
  { label: 'Rust', value: 'rust' },
  { label: 'Shell', value: 'shell' },
  { label: 'SQL', value: 'sql' },
] as const

export type CodeLanguage = typeof codeLanguages[number]['value']
export type CodeTokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'builtin' | 'property' | 'attribute' | 'tag' | 'operator'
export interface CodeToken { text: string; kind?: CodeTokenKind }

const aliases: Record<string, CodeLanguage> = {
  plaintext: 'plaintext', plain: 'plaintext', text: 'plaintext',
  c: 'c', cpp: 'c', 'c++': 'c',
  css: 'css', html: 'html', htm: 'html',
  javascript: 'javascript', js: 'javascript',
  python: 'python', py: 'python',
  rust: 'rust', rs: 'rust',
  shell: 'shell', bash: 'shell', sh: 'shell',
  sql: 'sql',
}

export function normalizeCodeLanguage(language: string): CodeLanguage | undefined {
  const key = language.trim().toLowerCase()
  return Object.hasOwn(aliases, key) ? aliases[key] : undefined
}
