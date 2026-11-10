import { useMemo } from 'react'
import { MathDisplay } from './MathDisplay'
import { renderMath } from './mathRender'

export function MathView({ latex }: { latex: string }) {
  const result = useMemo(() => renderMath(latex), [latex])
  return <MathDisplay latex={latex} result={result} />
}
