# Mote native format reference — V1

This public reference is a focused authoring specification for external agents; it does not require a repository checkout and contains no task data. Native V1 is a closed schema. A document is V1 only when `format` is exactly `"mote"` and `version` is the number `1`. Unknown versions and unknown fields are unsupported. Preserve unsupported inputs and report the issue; do not convert, extend, or repair them. The agent transport protocol is separate from the document version.

## Document envelope and theme

```ts
type MoteDocument = {
  format: 'mote'
  version: 1
  id: string
  language: 'en' | 'zh-Hans'
  page: { width: number; margins: Insets }
  theme: Theme
  content: MainDoc
  objects: Object[]
  authoring?: { notes: string[]; aiModel?: string }
}
type Insets = { top: number; right: number; bottom: number; left: number }
type Length = { value: number; unit: 'px' | 'em' }
type LineHeight = Length | { value: number; unit: 'ratio' }
type Family = 'sans' | 'serif' | 'mono'
type ParagraphClass = 'title' | 'heading' | 'subheading' | 'body' | 'caption' | 'list'
type PaletteFamily = 'primary' | 'secondary' | 'red' | 'amber' | 'green' | 'pink' | 'blue' | 'violet'
type PaletteRef = PaletteFamily | `${PaletteFamily}:soft` | 'gray1' | 'gray2' | 'gray3' | 'gray4' | 'gray5' | 'gray6'
type PairColor = PaletteFamily | 'gray4'
type TextStyle = {
  family: Family; size: Length; color: PaletteRef; weight: number
  lineHeight: LineHeight; spaceBefore: Length; spaceAfter: Length; letterSpacing: Length
}
type Theme = {
  appearance: { mode: 'light' | 'dark'; primaryHue: number; secondaryHue: number }
  autospace: boolean
  defaults: {
    family: Family; size: number; color: PaletteRef; weight: number
    lineHeight: LineHeight; spaceBefore: Length; spaceAfter: Length; letterSpacing: Length
  }
  paragraphs: Partial<Record<ParagraphClass, Partial<TextStyle>>>
  objects: {
    table?: Partial<TextStyle>
    code?: Partial<Pick<TextStyle, 'size' | 'weight' | 'lineHeight' | 'letterSpacing'>>
    formula?: Partial<Pick<TextStyle, 'size' | 'color'>>
  }
  flow: { spaceBefore?: Length; spaceAfter?: Length }
}
```

Page width is positive document pixels; all four page margins are nonnegative pixels. The standard new page is 960px wide with 32px left/right and 48px top/bottom margins. Appearance hues are finite degrees in `[0,360)`. If `authoring` is present it requires `notes`; `aiModel` is optional. `defaults.size` is positive pixels. Theme override `size` uses `Length`. Every length is a finite `{value,unit}` object, never a number or unit string. `em` resolves against `defaults.size`; a ratio line-height multiplies resolved font size. Font weight is finite from 1 through 1000. Sizes and line-height are positive; text padding and Before/After spacing are nonnegative; letter spacing may be signed. `em`/`px` units are not interchangeable with plain geometry numbers.

`theme.defaults` is complete. Paragraph/object style overrides are sparse and inherit omitted properties from Defaults. `theme.objects` has only the shown table, code, and formula overrides. Flow Before omission means zero; Flow After omission follows resolved Body `spaceAfter`. Do not add a palette, page-background field, or custom theme key.

The fixed palette is 22 slots: Strong/Soft pairs for Primary, Secondary, Red, Amber, Green, Pink, Blue, and Violet (`primary`, `secondary`, etc., with `:soft` for Soft), plus `gray1` through `gray6`. Grays have no Soft form. Primary/Secondary follow saved hues; every slot adapts to Light/Dark mode. `PairColor` used by text-box borders is one of the eight families or `gray4` (which pairs with Gray 5).

`authoring.notes` are internal user scratchpads. They can appear in authorized input as tentative context, but they are not automatic instructions or published content. Never edit Notes or include `authoring` in a candidate. Public shares and HTML exports omit `authoring`; native `.mote` files retain it.

## Main content, rich text, IDs

```ts
type MainDoc = { type: 'doc'; content: [MainBlock, ...MainBlock[]] }
type MainBlock = MainParagraph | Spacer | FlowAtom
type MainParagraph = {
  type: 'paragraph'
  attrs:
    | { id: string; semantic: Exclude<ParagraphClass, 'list'> }
    | { id: string; semantic: 'list'; listLevel: number }
  content?: Inline[]
}
type Spacer = { type: 'spacer'; attrs: { id: string; height: number } }
type FlowAtom = { type: 'flow'; attrs: { id: string; objectId: string } }
type Inline = { type: 'text'; text: string; marks?: Mark[] } | { type: 'hardBreak'; marks?: Mark[] }
type Mark =
  | { type: 'bold' }
  | { type: 'color'; attrs: { color: PaletteRef } }
  | { type: 'decoration'; attrs: { decoration: 'box' } }
  | { type: 'link'; attrs: { href: string } }
```

`content` is a nonempty `doc`. Main paragraphs, explicit spaces, and Flow atoms are its only top-level kinds. A paragraph has one stable `id` and semantic class. `listLevel` is a nonnegative integer required for `list` and forbidden for every other class. Spacer height is a finite nonnegative document-pixel number. Paragraph text may be empty; its `content` may be omitted or empty. Every `text` node has a nonempty string and every hard break is `{type:"hardBreak"}`. Newlines in text are not a substitute for hard breaks. Do not trim or normalize text.

The exact mark attributes are shown above: `bold` has no `attrs`; the other marks have exactly the stated `attrs`. Marks compose, but one mark type may occur only once per inline node. The fixed-palette example below is valid; arbitrary colors, font/size marks, independent underline marks, unknown marks, and relative links are not.

```json
{
  "type": "paragraph",
  "attrs": {"id": "p-1", "semantic": "body"},
  "content": [
    {"type":"text","text":"Bold","marks":[{"type":"bold"}]},
    {"type":"text","text":" color","marks":[{"type":"color","attrs":{"color":"secondary:soft"}}]},
    {"type":"text","text":" box","marks":[{"type":"decoration","attrs":{"decoration":"box"}}]},
    {"type":"text","text":" link","marks":[{"type":"link","attrs":{"href":"https://example.com/"}}]},
    {"type":"hardBreak"}
  ]
}
```

A link is a credential-free absolute HTTP(S) URL with a host and no control characters; `mailto:`, `tel:`, and relative paths are unsupported. Links inherit text color and render underlined. Links are valid in main text, text objects, table cells, and captions, not in Code or Drawing.

IDs match `[A-Za-z0-9_-]{1,128}`; `__proto__`, `constructor`, and `prototype` are forbidden. All main block IDs, object IDs, and rich-text/caption paragraph IDs are globally unique across the full document/composition. A Flow atom ID is a main-block ID and differs from its `objectId`. Create fresh IDs for new nodes; preserve the target paragraph/object ID when revising an existing target.

## Tables

Text-object `content` is a nonempty `doc` with paragraphs only. Table-object `content` is a `doc` with exactly one table, no other blocks. A table has one or more rows; every row has the same positive number of cells. Rows/cells have no `attrs`. Each cell contains exactly one paragraph; that paragraph has only `attrs:{id}` and optional inline content from the shared mark grammar. There are no merged cells, spans, nested tables, semantic attrs on cell paragraphs, or extra nodes.

```ts
type TextDoc = { type: 'doc'; content: [MainParagraph, ...MainParagraph[]] }
type TableDoc = { type: 'doc'; content: [TableNode] }
type TableNode = {
  type: 'table'
  attrs?: { columns?: { weight: number; align: 'left' | 'center' | 'right' }[] }
  content: [TableRow, ...TableRow[]]
}
type TableRow = { type: 'tableRow'; content: [TableCell, ...TableCell[]] }
type TableCell = { type: 'tableCell'; content: [CellParagraph] }
type CellParagraph = { type: 'paragraph'; attrs: { id: string }; content?: Inline[] }
type CaptionDoc = { type: 'doc'; content: [CaptionParagraph] }
type CaptionParagraph = { type: 'paragraph'; attrs: { id: string }; content?: Inline[] }
```

If `table.attrs.columns` is present, it has exactly one entry per column. Each entry is exactly `{weight:number,align:'left'|'center'|'right'}` with positive finite proportional weight; weights need not sum to one. Omission means equal weights and left alignment. Optional table `style` is `simple`, `academic`, or `business` (default `simple`); optional `headerRow` is boolean (default `false`). Cell paragraph styling is fixed.

## Objects, layout, and captions

Objects are ordered by stacking order. Every object is a closed tagged record with `id`, `kind`, and `layout`; only the kind-specific fields listed below are allowed.

```ts
type Object = {
  id: string
  kind: 'text' | 'table' | 'image' | 'drawing' | 'formula' | 'code' | 'html'
  layout: {
    width: number                 // positive document pixels
    height?: number               // required only for drawing and html
    margins?: Insets              // signed layout-footprint adjustments
    placement: Placement
  }
}
type Placement =
  | { type: 'flow'; x: number | 'center' }
  | { type: 'float'; anchorId: string | null; x: number; y: number }
```

All saved geometry is inside `layout`. Never put top-level `x`, `y`, `width`, `height`, `margins`, `placement`, `anchorId`, or `centered` fields on a native object. `layout.width` is positive. Only Drawing and HTML require positive saved `layout.height`. If present, `layout.margins` has all four finite signed pixel sides; omission means zero. Margins change the body-and-caption layout footprint, not body dimensions.

- **Flow:** every Flow object has exactly one top-level Flow atom with its own distinct block ID. The atom supplies block position. Its object placement is `{type:'flow',x:number|'center'}` with no anchor or saved `y`. Numeric x is relative to the text-column left; `"center"` centers in that column. The object occupies real normal flow at its natural rendered height.
- **Style spacing:** adjacent paragraphs and Flow blocks use the maximum of the preceding After and following Before. At the document edges, style spacing also collapses with the top/bottom page margin to their maximum. Object margins extend the body-and-caption layout footprint and stay additive, never collapsed. Explicit space blocks add their height to the surrounding collapsed style gap. Omitted Flow Before is zero; omitted Flow After follows Body.
- **Float:** `anchorId` is `null` (document top) or a main paragraph, spacer, or Flow atom ID. For null/ordinary paragraph/spacer anchors, x is page-space and y is a nonnegative anchor-relative offset. When anchored to a Flow atom, both x and y are signed offsets from the Flow owner's measured top-left. Floats may overlap one another and Flow objects. Main text uses only the interval left of an intersecting Float; it does not wrap around to its right.

| Kind | Required fields (besides `id`, `kind`, `layout`) | Optional fields |
| --- | --- | --- |
| `text` | `content` | `padding`, `decoration` |
| `table` | `content` | `style`, `headerRow`, `caption` |
| `image` | `src`, `alt` | `caption` |
| `drawing` | `strokes`, `labels`, `background` | — |
| `formula` | `latex` | — |
| `code` | `source`, `language` | — |
| `html` | `html`, `screenshot`, `alt` | `caption` |

- **Text:** `content` is a nonempty rich `TextDoc`. Optional `padding` is a nonnegative `Length`; omission means zero unless decorated, when presentation uses `0.75em`. Optional `decoration` is exactly `{kind:'left'|'box',color:PairColor}`. Omit it rather than storing null. Do not add `background` or `borderColor`.
- **Table:** `content` follows the exact grammar above; optional caption belongs to its owner.
- **Image:** `src` is embedded image data, never a path or remote URL; `alt` is accessible descriptive text. Image dimensions derive from intrinsic ratio and layout width.
- **Drawing:** positive layout height; `strokes` is an array of `{points:[[x,y],...],color,width}`. Each stroke has at least one finite point relative to the drawing top-left, a fixed-palette color, and positive document-pixel width. `labels` is an array of `{x,y,text,color,size}` with finite top-left-relative positions, fixed-palette color, and positive pixel font size. `background` is exactly `"gray6"` or `null`. Resizing scales point/label positions but preserves stroke widths and label sizes.
- **Formula:** `latex` is the source string rendered by KaTeX; there is no saved height. Candidate LaTeX has no `$`/`$$` delimiters.
- **Code:** `source` is exact plain text; `language` matches `[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}`. Common identifiers are `javascript`, `typescript`, `python`, `json`, `html`, `css`, `shell`, `sql`, and `plaintext`. Code is never executed and has no saved height.
- **HTML:** positive layout height; `html` is widget source, `screenshot` is embedded saved image data, and `alt` is an accessible description. HTML executes only in Mote's existing sandboxed widget boundary. Candidate validation never executes HTML or fetches URLs.

Native image data is embedded PNG, JPEG, WebP, GIF, AVIF, or safe inert SVG; each decoded image is limited to 10 MiB. PNG signatures are checked. Do not embed remote URLs or executable image formats.

Captions belong only to image, HTML, and table objects. Exact shape: `{content:CaptionDoc,width?:number}`. `CaptionDoc` has exactly one paragraph whose attrs contain only its ID; the paragraph uses shared inline grammar, not a semantic class. Optional width is positive document pixels. Captions are centered below their owner and participate in its composition/Flow height; they have no object ID, layout, independent position, or detach state. Omitted width follows owner width; explicit width stays fixed during owner resizing.

## Complete candidate examples

These are candidate result values, not complete cloud documents. The task's reserved target determines which example shape applies. Preserve the target's ID/kind/layout rules from `authoring.md`. A result has exactly one of `content`, `object`, or `segment`, plus required `summary` and optional `sources` (each source is `{title:string,url:absolute HTTPS URL}`). An individual HTML object result may also have root `screenshotPath`; a segment result may have root `screenshotPaths` keyed by HTML object ID. These path fields are delivery metadata, not native object fields, and the submission's `assets` must contain the actual PNG bytes. Do not include `authoring`.

### Main-text candidate

`p-1` must be the existing ID from the reserved paragraph target. This example uses exact valid mark attributes and returns the complete paragraph, not a substring.

```json
{
  "content": [
    {
      "type": "paragraph",
      "attrs": {"id": "p-1", "semantic": "body"},
      "content": [
        {"type":"text","text":"A careful "},
        {"type":"text","text":"revised passage","marks":[{"type":"bold"},{"type":"color","attrs":{"color":"secondary:soft"}}]},
        {"type":"text","text":" with a source link.","marks":[{"type":"link","attrs":{"href":"https://example.com/source"}}]}
      ]
    }
  ],
  "summary": "A concise revision of the reserved paragraph.",
  "sources": [{"title":"Example source","url":"https://example.com/source"}]
}
```

### Native object candidate: table

This complete table-object candidate demonstrates the rectangular table grammar. `table-target` stands for the actual reserved object ID; use globally unique cell-paragraph IDs in the composition. Preserve saved placement/dimensions when revising an existing object. The example assumes an existing Flow table target with its Flow atom in the document.

```json
{
  "object": {
    "id": "table-target",
    "kind": "table",
    "layout": {"width": 400, "placement": {"type":"flow", "x":"center"}},
    "style": "simple",
    "headerRow": true,
    "content": {
      "type": "doc",
      "content": [{
        "type": "table",
        "attrs": {"columns": [{"weight":2,"align":"left"},{"weight":1,"align":"right"}]},
        "content": [
          {"type":"tableRow","content":[
            {"type":"tableCell","content":[{"type":"paragraph","attrs":{"id":"cell-a"},"content":[{"type":"text","text":"Item","marks":[{"type":"bold"}]}]}]},
            {"type":"tableCell","content":[{"type":"paragraph","attrs":{"id":"cell-b"},"content":[{"type":"text","text":"Count"}]}]}
          ]},
          {"type":"tableRow","content":[
            {"type":"tableCell","content":[{"type":"paragraph","attrs":{"id":"cell-c"},"content":[{"type":"text","text":"Apples"}]}]},
            {"type":"tableCell","content":[{"type":"paragraph","attrs":{"id":"cell-d"},"content":[{"type":"text","text":"3"}]}]}
          ]}
        ]
      }]
    }
  },
  "summary": "A two-column table with a header row.",
  "sources": []
}
```

### Native object candidate: text box

This is also a complete native object result. In an existing-object revision, `target-box` and its saved layout must match the target. Text boxes do not own captions.

```json
{
  "object": {
    "id": "target-box",
    "kind": "text",
    "layout": {"width":280,"placement":{"type":"float","anchorId":"p-1","x":648,"y":16}},
    "content": {"type":"doc","content":[
      {"type":"paragraph","attrs":{"id":"box-p-1","semantic":"body"},"content":[
        {"type":"text","text":"A useful note","marks":[{"type":"bold"},{"type":"decoration","attrs":{"decoration":"box"}}]}
      ]}
    ]},
    "padding":{"value":0.75,"unit":"em"},
    "decoration":{"kind":"box","color":"primary"}
  },
  "summary": "A compact native note box.",
  "sources": []
}
```

### HTML widget candidate with screenshot

An individual HTML object result keeps screenshot path metadata at the candidate root, not inside `object`. `widget.png` must be a real PNG captured from the preview harness at exactly 320×180 pixels and supplied in `assets` when submitting. The example is not deliverable without that actual file and byte upload.

```json
{
  "object": {
    "id":"target-widget",
    "kind":"html",
    "layout":{"width":320,"height":180,"placement":{"type":"float","anchorId":"p-1","x":608,"y":16}},
    "html":"<button type=\"button\">Count: 0</button><script>let count=0;document.querySelector('button').onclick=event=>{event.currentTarget.textContent='Count: '+ ++count}</script>",
    "alt":"A counter button"
  },
  "screenshotPath":"widget.png",
  "summary":"A small interactive counter.",
  "sources":[]
}
```

### Complete segment candidate and geometry

A segment candidate is a complete native composition in the transfer-only envelope below. It contains main blocks and owned object records; it has no single object ID or fixed output-height box. `geometry`, `anchorTops`, and `originTop` are required transfer data, not saved document fields or `layout` fields. `geometry` maps object IDs to measured page-space body boxes `{x,y,width,height}` and may carry separate `captionWidth`/`margins` hints; `x` and `y` are measured absolute page coordinates, not Float anchor offsets. `anchorTops` maps top-level block IDs to their measured absolute document y; a partial spacer's value is the top of its selected slice. `originTop` is the absolute document y of the canonical start point. Use the same coordinate system for all three.

When the composition is inserted/replaced, absolute vertical measurements are translated by `insertionTop + (sourceY - originTop)`. For a Float whose `layout.placement.anchorId` names a block inside the payload, its saved `layout.placement.y` remains relative to that anchor; do not replace that offset with geometry's absolute y. A Flow object's position is its Flow atom; Float annotations anchored to it use signed x/y offsets from the Flow object's top-left. Keep every anchor inside `content`, and keep `geometry` IDs inside `objects` and `anchorTops` IDs inside top-level `content`.

This complete example has a paragraph, centered Flow image, and owned caption. Its measured image body is at page x=390, y=28, size 180×64 in a 960px page; the payload starts at y=0, the paragraph anchor top is y=0, and the Flow atom top is y=28. The measured `captionWidth` is separate from the 180px image body width.

```json
{
  "segment": {
    "version": 1,
    "type": "segment",
    "content": [
      {"type":"paragraph","attrs":{"id":"ai-paragraph","semantic":"body"},"content":[{"type":"text","text":"A composed idea"}]},
      {"type":"flow","attrs":{"id":"ai-flow","objectId":"ai-image"}}
    ],
    "objects": [
      {
        "id":"ai-image",
        "kind":"image",
        "src":"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22180%22%20height%3D%2264%22%3E%3Crect%20width%3D%22180%22%20height%3D%2264%22%20fill%3D%22%23e8eef7%22%2F%3E%3C%2Fsvg%3E",
        "alt":"A native figure",
        "layout":{"width":180,"placement":{"type":"flow","x":"center"}},
        "caption":{"content":{"type":"doc","content":[{"type":"paragraph","attrs":{"id":"ai-caption-paragraph"},"content":[{"type":"text","text":"A native figure"}]}]},"width":220}
      }
    ],
    "geometry":{"ai-image":{"x":390,"y":28,"width":180,"height":64,"captionWidth":220}},
    "anchorTops":{"ai-paragraph":0,"ai-flow":28},
    "originTop":0
  },
  "summary":"A native paragraph and Flow image with its built-in caption.",
  "sources":[]
}
```

The segment `content` array may be empty only for an intentional empty replacement. Add spacers for deliberate vertical room; do not encode spatial gaps as paragraph height or page padding. Flow reserves its object's natural height. The segment area's rectangle in `target.json` is selection/insertion context, not a maximum output size. Fit the composition to the supplied page width. Segment HTML uses one root `screenshotPaths` entry per HTML object ID, each naming a real PNG captured at that object's rounded body `layout.width` × `layout.height`; do not capture the full page or segment rectangle. For an individual HTML object use `screenshotPath` instead.

## Validation and practical limits

Validation is strict over received JSON. Unknown fields are rejected; do not normalize input through an editor schema before validating it. No arbitrary extension bag, custom colors, custom nodes/marks, or legacy conversion exists. Common bounds include 100,000 document nodes, depth 100, 8 Mi characters per string (except `alt` up to 4096 characters and `authoring.aiModel` up to 256), 10 MiB decoded per image, and drawing caps of 10,000 strokes, 100,000 points total, 1,000 labels, and 4,096 characters per label. Candidate HTTP/body limits and screenshot totals are described in [submission.md](submission.md).
