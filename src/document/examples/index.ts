import type { JSONContent } from '@tiptap/core'
import { captionContent, createBlankDocument, em, paragraph, tableContent, type BlockClass, type DocumentLanguage, type FloatingObject, type MoteDocument } from '../model'
import { focusWidget } from './focus'
import exampleMath from './math.tex?raw'

const landscape = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360"><rect width="600" height="360" fill="#e8ecdf"/><circle cx="450" cy="86" r="40" fill="#d9b678"/><path d="M0 238Q145 76 320 224T600 164V360H0Z" fill="#9aaa89"/><path d="M0 292Q156 196 340 278T600 228V360H0Z" fill="#54725b"/><path d="M240 360Q410 290 330 238" fill="none" stroke="#eee5c9" stroke-width="20"/><path d="M95 285V150m0 70q-65-8-53-54 53 7 53 54m0-26q59-4 49-49-49 6-49 49" fill="#35543e" stroke="#35543e" stroke-width="5"/></svg>')}`

export interface ExampleOptions { language?: DocumentLanguage; slideHeight?: number }

export function createExampleDocument({ language = 'en', slideHeight }: ExampleOptions = {}): MoteDocument {
  const slides = slideHeight !== undefined
  const text = (en: string, zh: string) => language === 'en' ? en : zh
  const p = (en: string, zh: string, semantic: BlockClass = 'body') => paragraph(text(en, zh), semantic)
  const caption = (en: string, zh: string) => ({ content: captionContent(text(en, zh)) })
  const document = createBlankDocument()
  document.language = language
  const objects = document.objects
  const base = (width: number) => ({ id: crypto.randomUUID(), layout: { width, placement: { type: 'flow' as const, x: 'center' as const } } })
  const flow = (object: FloatingObject): JSONContent => {
    objects.push(object)
    return { type: 'flow', attrs: { id: crypto.randomUUID(), objectId: object.id } }
  }
  const space = (height: number): JSONContent => ({ type: 'spacer', attrs: { id: crypto.randomUUID(), height } })

  const image = flow({ ...base(slides ? 440 : 600), kind: 'image', src: landscape,
    alt: text('A winding path between green hills beneath a golden sun.', '金色阳光下，一条小路蜿蜒穿过青绿的山丘。'),
    caption: caption('A path worth following. The caption belongs to the image.', '沿着小路，慢慢发现。图注属于这幅图像。') })
  objects.push({ id: crypto.randomUUID(), kind: 'text',
    layout: { width: 190, placement: { type: 'float', anchorId: image.attrs!.id, x: slides ? 310 : 460, y: 30 } },
    decoration: { kind: 'box', color: 'primary' },
    content: { type: 'doc', content: [p('Take the scenic route', '不妨绕一点远路', 'caption'), p('Move the image. This anchored note comes along.', '移动图像，这张锚定的便笺也会跟着走。', 'caption')] } })

  const alongside = p('A good question does not have to interrupt the main thread. This paragraph leaves room for a Float on its right. The note is anchored here, so it follows the passage as earlier text grows.',
    '一个好问题，不必打断叙述的主线。这段文字会为右侧的浮动便笺留出空间。便笺锚定在这里；前文增加时，它会跟着这段话一起下移。')
  objects.push({ id: crypto.randomUUID(), kind: 'text',
    layout: { width: 250, placement: { type: 'float', anchorId: alongside.attrs!.id, x: 650, y: 0 } },
    decoration: { kind: 'left', color: 'secondary' }, content: { type: 'doc', content: [
      p('A different angle', '换个角度', 'subheading'), p('What would you notice if you slowed down?', '如果慢下来，你会注意到什么？'),
    ] } })

  const table = flow({ ...base(820), kind: 'table', style: 'academic', headerRow: true,
    content: tableContent(language === 'en' ? [
      ['An idea needs…', 'Use', 'Try it'],
      ['A place in the story', 'Flow', 'Move this table between paragraphs'],
      ['A position beside it', 'Float', 'Drag the margin note'],
      ['A little explanation', 'Caption', 'Edit the text below this table'],
      ['A change of pace', slides ? 'Slide break' : 'Explicit space', slides ? 'Add → Slide break' : 'Alt-drag at a boundary'],
    ] : [
      ['当想法需要……', '可以使用', '动手试试'],
      ['叙述中的位置', 'Flow · 随文', '把这张表格移到其他段落之间'],
      ['主线旁的空间', 'Float · 浮动', '拖动页边的便笺'],
      ['补充一句说明', '图注', '编辑表格下方的文字'],
      ['节奏上的变化', slides ? '幻灯片分隔符' : '显式留白', slides ? 'Add → Slide break' : '在边界处按住 Alt 拖动'],
    ]), caption: caption('Native cells, an academic rule style, and an owned caption. All editable.', '原生单元格、学术风格的表格线，以及随表移动的图注。它们都可以编辑。') })

  const drawing = flow({ ...base(680), kind: 'drawing', layout: { ...base(680).layout, height: 200 }, background: null,
    strokes: [
      { color: 'primary', width: 3, points: [[40, 130], [70, 98], [95, 120], [125, 68], [155, 90], [185, 44], [218, 66], [250, 28]] },
      { color: 'gray3', width: 2, points: [[290, 92], [335, 92], [324, 82], [335, 92], [324, 102]] },
      { color: 'secondary', width: 3, points: [[380, 130], [420, 105], [460, 90], [500, 55], [540, 46], [590, 24]] },
    ], labels: [
      { x: 40, y: 170, text: text('Catch a thought', '捕捉一个念头'), color: 'gray2', size: 20 },
      { x: 380, y: 170, text: text('Give it a shape', '让想法有形'), color: 'gray2', size: 20 },
    ] })
  const fullMath = language === 'en' ? exampleMath : exampleMath.replace(/Roots|Series|Calculus|Matrices|rotation|Cases|if |Vectors/g,
    label => ({ Roots: '求根', Series: '级数', Calculus: '微积分', Matrices: '矩阵', rotation: '旋转', Cases: '分段', 'if ': '当 ', Vectors: '向量' })[label]!)
  const formula = flow({ ...base(800), kind: 'formula', latex: slides ? String.raw`\begin{aligned}
f(x)&=e^{-x^2}, & \int_{-\infty}^{\infty}f(x)\,\mathrm{d}x&=\sqrt{\pi} \\[1em]
R(\theta)&=\begin{bmatrix}\cos\theta&-\sin\theta\\\sin\theta&\cos\theta\end{bmatrix}, & \boldsymbol{v}'&=R(\theta)\boldsymbol{v}
\end{aligned}` : fullMath.trim() })
  const code = flow({ ...base(800), kind: 'code', language: 'javascript', source: text(
    '// Make room for a small discovery.\nconst minutes = { read: 24, write: 20, explore: 16 }\nconst total = Object.values(minutes)\n  .reduce((sum, value) => sum + value, 0)\n\nconsole.log(`${total} minutes for curiosity`)',
    '// 给小小的发现留一点时间。\nconst minutes = { read: 24, write: 20, explore: 16 }\nconst total = Object.values(minutes)\n  .reduce((sum, value) => sum + value, 0)\n\nconsole.log(`留给好奇心的 ${total} 分钟`)') })
  const widget = flow({ ...base(760), kind: 'html', layout: { ...base(760).layout, height: 280 }, ...focusWidget(language),
    caption: caption('A live HTML widget; its saved preview appears in PNG and the minimap.', '可交互的 HTML 组件；PNG 导出和缩略图使用它保存的预览图。') })

  const intro = { ...p('', ''), content: [
    { type: 'text', text: text('Follow a thought with ', '用文字串起思路，用 ') },
    { type: 'text', text: 'Flow', marks: [{ type: 'bold' }, { type: 'color', attrs: { color: 'primary' } }] },
    { type: 'text', text: text('. Keep a question nearby with ', ' 安放图表，用 ') },
    { type: 'text', text: 'Float', marks: [{ type: 'color', attrs: { color: 'secondary' } }, { type: 'decoration', attrs: { decoration: 'box' } }] },
    { type: 'text', text: text('. Make room for what comes next.', ' 留住旁支的问题。为下一个想法，留一点空间。') },
  ] }
  const link = { ...p('', ''), content: [
    { type: 'text', text: text('A link can be part of the sentence: ', '链接也可以自然地融入句子：') },
    { type: 'text', text: text('wander through a collection of ideas', '去百科全书里逛逛'), marks: [
      { type: 'link', attrs: { href: text('https://en.wikipedia.org/wiki/Curiosity', 'https://zh.wikipedia.org/wiki/好奇心') } },
      { type: 'color', attrs: { color: 'secondary' } },
    ] },
    { type: 'text', text: text('. Ctrl/⌘-click while editing; click normally in Preview or a reader.', '。编辑时按住 Ctrl/⌘ 点击；阅读时直接点击。') },
  ] }

  const sections: JSONContent[][] = [
    [p(slides ? 'One thought at a time.' : 'A little room to think.', slides ? '一页，一个想法。' : '给思考，留一点空间。', 'title'),
      p(slides ? 'A ten-slide field guide to Mote.' : 'A field guide on one continuous page.', slides ? '用十页幻灯片，探索 Mote。' : '在一张连续的页面上，探索 Mote。', 'caption'), intro,
      p('This is a working document, not a picture of one. Edit the words, move a figure, or open a drawing.', '这是一份可以动手修改的文档，不是一张截图。改写文字、移动图像，或打开绘图试试。'),
      link],
    [p('Give a figure its place', '给图像一个位置', 'heading'),
      p(slides ? 'Flow makes room. An anchored Float adds another layer.' : 'A Flow image takes its own vertical space. Add text above it and the figure moves down naturally; its caption and anchored annotation travel with it.',
        slides ? '随文对象撑开空间，锚定的浮动便笺叠在图像之上。' : '随文图像拥有自己的纵向空间。在上方增加文字，图像就会自然下移；图注和锚定的便笺也会随它移动。'), image],
    [p('Keep a question nearby', '让问题留在身旁', 'heading'), alongside,
      p('Placement is independent of content. Select the note and try Context → Flow / Float. Use Undo to return it to the margin.',
        '放置方式与内容彼此独立。选中便笺，在 Context 中切换 Flow / Float，再用撤销把它放回页边。'),
      p('Move a whole passage', '整段思路，一起移动', 'subheading'),
      p('Drag in the left gutter to select a section. Move or copy its text, Flow objects, captions, and anchored notes together.',
        '在左侧边栏拖动，选中一个区段。文字、随文对象、图注和锚定的便笺，可以一起移动或复制。')],
    [p('Structure, without flattening', '保留结构，也保留弹性', 'heading'),
      p('A real table: edit a cell, resize a column, or switch its style in Context.', '这是真正的表格：修改单元格、调整列宽，或在 Context 中切换样式。'), table],
    [p('Start with a sketch', '先画下来，再慢慢想', 'heading'),
      p('Double-click the drawing to add strokes, erase, or edit labels. These marks are native, not a flattened image.', '双击绘图，添加笔画、擦除线条或编辑标签。这些是原生的绘图元素，不是合并后的图片。'), drawing,
      p('Select the sketch → Assistant → Reserve for Assistant. Ask for a refined figure, then review before accepting.',
        '选中草图 → Assistant → Reserve for Assistant。请助手把草图整理成图示，查看候选结果后再决定是否接受。', 'caption')],
    [p('Let the notation speak', '让公式说清楚', 'heading'),
      p('Integrals, matrices, vectors, and aligned equations share one editable LaTeX source.', '积分、矩阵、向量和对齐的等式，共用一份可编辑的 LaTeX 源码。'), formula,
      p('Select the formula to edit its source in Context. Math style changes the document-wide formula size and color.', '选中公式，在 Context 中编辑源码。Math style 可以统一调整文档中公式的字号与颜色。')],
    [p('Keep the source close', '让源码就在手边', 'heading'),
      p('Code keeps whitespace, line numbers, syntax colors, and an exact-source Copy action. It is displayed, not executed.', '代码保留空白、行号和语法高亮，还能一键复制原始源码。代码对象只展示内容，不执行程序。'), code],
    [p('Invite the reader to explore', '让读者也能动手探索', 'heading'),
      p(slides ? 'Choose a rhythm below. This widget works offline, too.' : 'Select the widget once in the editor, then try its buttons. In Preview or a reader, interact directly. Its HTML, CSS, and JavaScript run in a sandbox, with no external dependencies.',
        slides ? '选择下方的一种节奏。这个组件离线也能使用。' : '编辑时先选中组件，再点击按钮；阅读时可以直接交互。它的 HTML、CSS 和 JavaScript 在沙盒中运行，不依赖外部资源。'), widget],
    [p(slides ? 'A pause, inside a page' : 'Whitespace is content, too', slides ? '一页之内，也可以停顿' : '留白，也是内容', 'heading'),
      p('The gap below is explicit space. Hold Alt near a block boundary to add or resize it; objects in Flow already make their own room.', '下方的间隔是显式留白。在块边界附近按住 Alt 拖动，可以添加或调整它；随文对象已经会自动撑开空间。'),
      space(slides ? 48 : 96),
      p('A quiet change of pace.', '停一下，再继续。', 'caption'),
      p(slides ? 'Each slide has a saved crop. Settings → Document → Layout changes its height; Add → Slide break starts another slide.' : 'Prefer a sequence of pages? Enable Slides in Settings → Document → Layout. The separate Slides example is composed for a 960 × 540 page.',
        slides ? '每页幻灯片都有保存的裁切范围。在 Settings → Document → Layout 中调整高度，用 Add → Slide break 开始新的一页。' : '想分成一页一页来讲？在 Settings → Document → Layout 中启用 Slides。独立的幻灯片示例按 960 × 540 页面编排。')],
    [p('Make this space yours', '把这里变成你的工作台', 'heading'),
      p('Use semantic Title, Heading, and Body styles. Settings → Document → Theme changes the palette, typography, and Light / Dark appearance together.', '使用语义化的标题、章节与正文样式。在 Settings → Document → Theme 中统一调整配色、字体与明暗外观。'),
      p('In the editor, open the title to find Files. Changes save locally and sync to the cloud; Ctrl/⌘S syncs now.', '编辑时点击顶栏文件名打开 Files。修改会保存在本地并同步到云端；按 Ctrl/⌘S 立即同步。', 'list'),
      p('Use Notes for private scratch work. Notes stay out of public links, PNG, and HTML.', '用 Notes 记下内部草稿。公开链接、PNG 和 HTML 都不会包含这些笔记。', 'list'),
      p('Reserve a passage in Assistant, describe a change, and review the candidate before accepting.', '在 Assistant 中预留一段内容，描述修改需求，查看候选结果后再接受。', 'list'),
      p('Share offers an optional reading link and exports to .mote, HTML, or PNG. Private blocks public links, not local exports.', 'Share 提供可选的阅读链接，以及 .mote、HTML 和 PNG 导出。Private 会禁止公开链接，但不影响本地导出。', 'list'),
      p('Keep what helps. Change the rest.', '留下有用的，其余的，随你改写。', 'caption')],
  ]

  if (slides) {
    document.version = 2
    document.page.slideHeight = slideHeight
    document.theme.paragraphs.title = { ...document.theme.paragraphs.title, spaceBefore: em(0), spaceAfter: em(1.5) }
    document.theme.paragraphs.heading = { ...document.theme.paragraphs.heading, spaceBefore: em(0), spaceAfter: em(1) }
    document.theme.paragraphs.subheading = { ...document.theme.paragraphs.subheading, spaceBefore: em(1) }
    document.theme.flow = { spaceBefore: em(1), spaceAfter: em(1) }
  }
  document.content = { type: 'doc', content: sections.flatMap((section, index) => slides && index > 0
    ? [{ type: 'slideBreak', attrs: { id: crypto.randomUUID() } }, ...section] : section) }
  return document
}
