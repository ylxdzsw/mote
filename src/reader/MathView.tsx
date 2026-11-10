import { useContext } from 'react'
import { MathDisplay } from '../canvas/MathDisplay'
import { PreparedContentContext } from './PreparedContent'

export function MathView({ latex }: { latex: string }) {
  const result = useContext(PreparedContentContext).math[latex]
  return <MathDisplay latex={latex} result={result ?? { error: 'Formula rendering data is missing from this standalone reader.' }} />
}
