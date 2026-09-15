import { useMemo } from 'react'
import katex from 'katex'
import css from 'katex/dist/katex.min.css?raw'
import './embeds.css'

// Embed only modern math fonts, including in standalone HTML and SVG-based PNGs.
const fonts = import.meta.glob<string>('../../node_modules/katex/dist/fonts/*.woff2', { eager: true, query: '?url&inline', import: 'default' })
const mathCss = css.replace(/src:url\(fonts\/([^)]*\.woff2)\)[^}]+/g, (_, file: string) =>
  `src:url("${fonts[`../../node_modules/katex/dist/fonts/${file}`]}") format("woff2")`)

export function MathView({ latex }: { latex: string }) {
  const result = useMemo(() => {
    try { return { html: katex.renderToString(latex, { displayMode: true, trust: false, output: 'htmlAndMathml', throwOnError: true }) } }
    catch (error) { return { error: (error as Error).message } }
  }, [latex])
  return <>
    <style href="mote-math-fonts" precedence="math">{mathCss}</style>
    {result.error ? <div className="math-content math-error" role="alert"><code>{latex}</code><span>{result.error}</span></div>
      : <div className="math-content" dangerouslySetInnerHTML={{ __html: result.html! }} />}
  </>
}
