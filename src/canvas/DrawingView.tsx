import type { FloatingDrawing } from '../document/model'
import { drawingStrokePath } from '../document/drawing'
import { paletteCSS } from '../theme/palette'

export function DrawingView({ drawing }: { drawing: FloatingDrawing }) {
  return <svg xmlns="http://www.w3.org/2000/svg" className="drawing-view"
    viewBox={`0 0 ${drawing.width} ${drawing.height}`} width={drawing.width} height={drawing.height}
    role="img" aria-label={drawing.labels.map(label => label.text).join(', ') || 'Drawing'} focusable="false"
    style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: `${drawing.width} / ${drawing.height}`, overflow: 'hidden', pointerEvents: 'none', userSelect: 'none' }}>
    {drawing.background === 'gray6' && <rect width={drawing.width} height={drawing.height} fill={paletteCSS('gray6')} />}
    {drawing.strokes.map((stroke, index) => stroke.points.length === 1
      ? <circle key={index} cx={stroke.points[0][0]} cy={stroke.points[0][1]} r={stroke.width / 2} fill={paletteCSS(stroke.color)} />
      : <path key={index} d={drawingStrokePath(stroke.points)} fill="none" stroke={paletteCSS(stroke.color)} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}
    {drawing.labels.map((label, index) => <text key={index} x={label.x} y={label.y} fill={paletteCSS(label.color)}
      fontSize={label.size} fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight="400" dominantBaseline="text-before-edge" style={{ whiteSpace: 'pre' }}>
      {label.text.split('\n').map((line, lineIndex) => <tspan key={lineIndex} x={label.x} dy={lineIndex ? label.size * 1.2 : 0}>{line}</tspan>)}
    </text>)}
  </svg>
}
