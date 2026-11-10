import { createContext } from 'react'
import type { CodeToken } from '../document/code'
import type { MathResult } from '../canvas/mathRender'

export interface PreparedContent {
  code: Record<string, CodeToken[]>
  math: Record<string, MathResult>
}

export const PreparedContentContext = createContext<PreparedContent>({ code: {}, math: {} })
