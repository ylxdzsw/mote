import katex from 'katex'

export type MathResult = { html: string } | { error: string }

export function renderMath(latex: string): MathResult {
  try {
    return { html: katex.renderToString(latex, { displayMode: true, trust: false, output: 'htmlAndMathml', throwOnError: true }) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}
