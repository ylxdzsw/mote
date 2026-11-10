import css from 'katex/dist/katex.min.css?raw'
import './embeds.css'
import type { MathResult } from './mathRender'

const fonts = import.meta.glob<string>('../../node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?url&inline', import: 'default' })
const mathCss = css.replace(/src:url\(fonts\/([^)]*\.woff2)[^}]+/g, (_, file: string) =>
  `src:url("${fonts[`../../node_modules/katex/dist/fonts/${file}`]}") format("woff2")`)

export function MathDisplay({ latex, result }: { latex: string; result: MathResult }) {
  return <>
    <style href="mote-math-fonts" precedence="math">{mathCss}</style>
    {'error' in result ? <div className="math-content math-error" role="alert"><code>{latex}</code><span>{result.error}</span></div>
      : <div className="math-content" dangerouslySetInnerHTML={{ __html: result.html }} />}
  </>
}
