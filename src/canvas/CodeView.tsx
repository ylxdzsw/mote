import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { FloatingCode } from '../document/model'
import { SourceEditor } from '../editor/SourceEditor'
import { codeLanguages, normalizeCodeLanguage } from '../document/code'
import './code.css'

export interface CodeViewProps {
  note: FloatingCode
  editable: boolean
  staticOnly?: boolean
  onChange?: (source: string) => void
  onActive?: () => void
  onBegin?: (event: ReactPointerEvent) => void
}

function languageName(language: string) {
  const value = normalizeCodeLanguage(language)
  return codeLanguages.find(option => option.value === value)?.label ?? (language.trim() || 'Plain text')
}

export function CodeView({ note, editable, staticOnly = false, onChange, onActive, onBegin }: CodeViewProps) {
  const source = note.source
  const copyTimer = useRef<number | undefined>(undefined)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const canEdit = editable && !staticOnly
  useEffect(() => () => { if (copyTimer.current !== undefined) clearTimeout(copyTimer.current) }, [])

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source)
      else throw new Error('Clipboard unavailable')
    } catch {
      try {
        const focused = document.activeElement as HTMLElement | null
        const helper = document.createElement('textarea')
        helper.value = source
        helper.setAttribute('readonly', '')
        helper.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
        document.body.append(helper)
        helper.select()
        const copied = document.execCommand('copy')
        helper.remove()
        focused?.focus({ preventScroll: true })
        if (!copied) throw new Error('Copy failed')
        setCopyState('copied')
      } catch {
        setCopyState('failed')
      }
      if (copyTimer.current !== undefined) clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500)
      return
    }
    setCopyState('copied')
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1500)
  }

  return <div className={`code-view${note.scheme === 'dark' ? ' code-dark' : ' code-light'}${canEdit ? ' code-can-drag' : ''}${staticOnly ? ' code-static' : ''}`} data-scheme={note.scheme}>
    <div className="code-header" onPointerDown={event => {
      if (event.target instanceof Element && event.target.closest('[data-code-copy]')) { event.stopPropagation(); return }
      if (event.button === 0 && canEdit) { event.stopPropagation(); onBegin?.(event) }
    }}>
      <span className="code-language">{languageName(note.language)}</span>
      {!staticOnly && <button type="button" data-code-copy="" className="code-copy" aria-label="Copy full code source"
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); void copy() }}>
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
      </button>}
    </div>
    <SourceEditor source={source} language={note.language} editorId={`code:${note.id}`} canEdit={canEdit}
      label={`${languageName(note.language)} source`} onChange={onChange} onActive={onActive} />
  </div>
}
