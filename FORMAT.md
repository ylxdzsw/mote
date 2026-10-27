# Mote document format V1

This is the normative specification for the native Mote document and its V1
composition data. A document is V1 only when `format` is exactly `"mote"` and
`version` is the number `1`. Unknown versions and unknown fields are rejected;
there is no extension bag or implicit compatibility mode.

## Version dispatch and preservation

The single load boundary is `loadDocument(value)`. It dispatches by version and
currently validates V1 without cloning, mutating, or rewriting the supplied
document. Future explicit conversions, if ever approved, belong at this
boundary. No migration registry or V0 converter exists. An unsupported or
malformed document produces an actionable error and remains unchanged and
recoverable; it is never replaced with an example. A failed or unsupported
import leaves the current document untouched. **From example** remains an
explicit New File choice.

Cloud documents and unresolved AI state are preserved as stored. Old task
snapshots are not converted: operations that would interpret or mutate an
unsupported task input fail explicitly, without deleting the task or
automatically retrying generation. A document-format change is a new document
version, not an optional extension. The agent transport identifier
`mote-agent-v1` is a separate protocol version and does not replace the
document's numeric `version`.

## Top-level document

The exact top-level shape is:

```ts
type MoteDocument = {
  format: 'mote'
  version: 1
  id: string
  language: 'en' | 'zh-Hans'
  page: {
    width: number                 // document pixels, > 0
    margins: Insets               // document pixels, all sides >= 0
  }
  theme: Theme
  content: MainDoc
  objects: Object[]               // array order is stacking order
  authoring?: {
    notes: string[]
    aiModel?: string
  }
}

type Insets = { top: number; right: number; bottom: number; left: number }
```

`page.width` and page margins are document-pixel numbers. The standard new
page is 960px wide with 48px top/bottom and 32px left/right margins. Language
is required. The optional `authoring` object, when present, requires `notes`;
omitting `authoring` means there are no notes or document model override.
Notes are user-owned plain-text scratchpads, not published page content.

A new document starts in Light mode with Primary hue 29°, Secondary hue 262°,
mixed-script autospace enabled, and a 16px Sans default in Gray 2 at weight
400. Its default line height is 1.5em, Before is 0em, After is 1em, and
letter spacing is 0em. New themes seed Title, Heading, Subheading, Body,
Caption, and List paragraph styles; Table, Code, and Formula object styles;
and an empty `flow` override. The seeded Subheading style is 1.125em at weight
600, line height 1.5em, Before 2em, After 0.5em; absence in another theme
still means inheritance from Defaults, not this preset.

Privacy, sharing, cloud/task revisions, selection, zoom, and other view state
are not document fields. Native saves preserve `authoring`. Public shared
responses and standalone HTML exports omit `authoring` entirely; HTML import
therefore has no authoring notes/model. Authorized AI inputs may include notes
as tentative, read-only context, but candidates cannot edit `authoring`.

## Theme

```ts
type Length = { value: number; unit: 'px' | 'em' }
type LineHeight = Length | { value: number; unit: 'ratio' }
type Family = 'sans' | 'serif' | 'mono'
type PaletteFamily = 'primary' | 'secondary' | 'red' | 'amber' | 'green' | 'pink' | 'blue' | 'violet'
type PaletteRef = PaletteFamily | `${PaletteFamily}:soft` | 'gray1' | 'gray2' | 'gray3' | 'gray4' | 'gray5' | 'gray6'
type PairColor = PaletteFamily | 'gray4'
type Theme = {
  appearance: {
    mode: 'light' | 'dark'
    primaryHue: number       // degrees, 0 <= hue < 360
    secondaryHue: number     // degrees, 0 <= hue < 360
  }
  autospace: boolean
  defaults: {
    family: Family
    size: number             // positive document pixels
    color: PaletteRef
    weight: number
    lineHeight: LineHeight
    spaceBefore: Length
    spaceAfter: Length
    letterSpacing: Length
  }
  paragraphs: Partial<Record<ParagraphClass, Partial<TextStyle>>>
  objects: {
    table?: Partial<TextStyle>
    code?: Partial<Pick<TextStyle, 'size' | 'weight' | 'lineHeight' | 'letterSpacing'>>
    formula?: Partial<Pick<TextStyle, 'size' | 'color'>>
  }
  flow: { spaceBefore?: Length; spaceAfter?: Length }
}

type TextStyle = {
  family: Family
  size: Length
  color: PaletteRef
  weight: number
  lineHeight: LineHeight
  spaceBefore: Length
  spaceAfter: Length
  letterSpacing: Length
}
type ParagraphClass = 'title' | 'heading' | 'subheading' | 'body' | 'caption' | 'list'
```

Theme objects have closed keys. `defaults` is complete; paragraph and object
overrides are sparse. A missing style or style property inherits from the
saved defaults. There is no special implicit Subheading fallback: new-document
themes seed a Subheading style explicitly. Table and caption paragraph styling
is semantic and fixed; `objects.table` controls the table's theme typography.
Code is always monospace and its theme style accepts only size, weight, line
height, and letter spacing. Formula accepts only size and color.

All finite `Length` values are `{value,unit}` objects—never numbers or unit
strings. `em` resolves against `defaults.size`; pixel values use document
pixels. `LineHeight` may instead use `{value,unit:'ratio'}`, which multiplies
the resolved style font size. Default size, override sizes, and line height
must be positive. Before/After spacing and text padding are nonnegative;
letter spacing may be signed. Font weight is finite and from 1 through 1000.
Flow Before omission means zero; Flow After omission follows the resolved
Body `spaceAfter`.

The default Title style inherits the Defaults family, is 2.5em, semibold (600),
Gray 2, with 3.5em line height and 3em Before and After. Heading
is 1.5em, Gray 2, 2em line height, 2em Before, and 1.5em After. Body is
1em. Caption is 0.75em Gray 3 with 1.25em line height. List is 1em with
0.375em After. The default Table object style is 1em; Code is 0.875em with
1.375em line height; Formula inherits Defaults. Other omitted style
properties inherit Defaults.

Adjacent main paragraphs and Flow blocks collapse their style spacing: the gap
is the maximum of the preceding block's After and the following block's Before.
At the page edges, Before/After collapses with the top/bottom page margin in the
same way. Object margins remain additive inside the object's layout footprint;
they never participate in style-space collapse. Explicit spaces add their saved
height to the surrounding collapsed style gap.

The fixed 22-slot palette has eight Strong/Soft pairs—Primary, Secondary, Red,
Amber, Green, Pink, Blue, and Violet—and six adaptive grays (`gray1` through
`gray6`). A strong color is its lowercase family name; a soft color adds
`:soft`. Grays have no Soft form. Primary and Secondary follow the saved hues;
all slots adapt to Light/Dark mode. There are no custom palettes, saved hex
colors, or page-background fields.

## Main content and rich-text grammar

`content` is a nonempty `{type:'doc',content:[...]}`. Its top-level nodes are
only paragraphs, explicit spaces, and Flow atoms:

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
type Inline =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hardBreak'; marks?: Mark[] }
type Mark =
  | { type: 'bold' }
  | { type: 'color'; attrs: { color: PaletteRef } }
  | { type: 'decoration'; attrs: { decoration: 'box' } }
  | { type: 'link'; attrs: { href: string } }
```

```json
[
  {"type":"paragraph","attrs":{"id":"p-1","semantic":"body"},"content":[{"type":"text","text":"A note","marks":[{"type":"bold"}]}]},
  {"type":"spacer","attrs":{"id":"space-1","height":24}},
  {"type":"flow","attrs":{"id":"flow-block-1","objectId":"object-1"}}
]
```

The shapes above are shown as separate nodes. A main paragraph has a stable
`id`, one semantic class, and an optional nonnegative integer `listLevel` only
when its semantic is `list`. Every list paragraph has a `listLevel`; other
classes must not. Paragraph text can be empty, and its `content` may be
omitted or empty. Main paragraphs use only inline text and hard breaks.
`text` nodes contain nonempty strings; `{type:'hardBreak'}` represents a line
break. No generic trimming or newline normalization is performed.

Every inline mark array is optional and may be empty. The closed mark grammar
is:

```json
[
  {"type":"bold"},
  {"type":"color","attrs":{"color":"secondary:soft"}},
  {"type":"decoration","attrs":{"decoration":"box"}},
  {"type":"link","attrs":{"href":"https://example.com/"}}
]
```

Marks compose, but a mark type may occur at most once on a node. `bold` has no
attributes; the other marks have exactly the shown attribute. Link `href` is a
credential-free absolute HTTP(S) URL with a host; controls, relative paths,
`mailto:`, and `tel:` are invalid. Links inherit text color and are rendered
underlined. There is no independent underline mark. No arbitrary inline fonts,
sizes, colors, or unknown node/mark fields are allowed.

Text-object content is a nonempty doc containing paragraphs only; it has the
same semantic paragraph grammar as main text. Table content is a doc with
exactly one table. Each row has the same number of cells, each cell contains
exactly one paragraph, and rows/cells have no attributes. Cell paragraph attrs
contain only an ID. There are no spans, merged cells, or additional table
content nodes. An optional `table.attrs.columns` array has one entry per
column, each exactly `{weight:number,align:'left'|'center'|'right'}`; weight
is positive and columns are proportional, so weights need not sum to one.
Omission means equal weights and left alignment. Optional table style is
`simple`, `academic`, or `business`; optional `headerRow` is boolean.

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

Caption content is a doc with exactly one paragraph whose attrs contain only
its ID. It uses the shared inline grammar, not a semantic paragraph class.

## IDs, objects, and layout

IDs are strings matching `[A-Za-z0-9_-]{1,128}`; `__proto__`, `constructor`,
and `prototype` are forbidden. All main-content IDs, rich-text paragraph IDs
inside objects, object IDs, and caption paragraph IDs are globally unique
within a document. Flow atom IDs are main block IDs. Every Flow atom's
`objectId` names exactly one Flow object, and every Flow object has exactly
one atom. IDs in copied content are refreshed and anchors remapped.

Objects are explicit tagged records with this common shell:

```ts
type Object = {
  id: string
  kind: 'text' | 'table' | 'image' | 'drawing' | 'formula' | 'code' | 'html'
  layout: {
    width: number              // positive document pixels
    height?: number            // required only by drawing and html
    margins?: Insets           // signed document-pixel adjustments
    placement: Placement
  }
  // exactly the fields allowed for this kind, described below
}

type Placement =
  | { type: 'flow'; x: number | 'center' }
  | { type: 'float'; anchorId: string | null; x: number; y: number }
```

`layout` is the only stored location for geometry. Do not store top-level
`x`, `y`, `width`, `height`, `margins`, `placement`, `anchorId`, or
`centered`. Flow placement has no saved anchor or y coordinate. Its one main
Flow atom supplies its position in block order; numeric Flow x is an offset
from the text-column left, and `'center'` centers within the column.

Float `anchorId` is null (document top) or a main paragraph, spacer, or Flow
atom ID. For document-top and ordinary paragraph/space anchors, x is in page
coordinates and y is a nonnegative offset from the anchor's measured top. A
Float anchored to a Flow atom instead uses signed x and y offsets from its
Flow owner's measured top-left. Floats may overlap other Floats and Flow
objects. Main text occupies only the interval to the left of intersecting
Floats; it does not wrap around to their right.

Object array order is stacking order. `layout.margins`, when present, contains
all four signed finite sides; omission means zero. Margins change the
body-and-caption layout footprint, not body dimensions. Layout uses that
footprint; hit testing, resizing, and annotation anchors use actual body
bounds. Visible extents remain included even when margins are negative. A
caption is part of its owner's composition and contributes to Flow height and
composition bounds.

## Object kinds and exact fields

Only the fields listed for a kind are permitted in addition to `id`, `kind`,
and `layout`.

| Kind | Required fields | Optional fields |
| --- | --- | --- |
| `text` | `content` | `padding`, `decoration` |
| `table` | `content` | `style`, `headerRow`, `caption` |
| `image` | `src`, `alt` | `caption` |
| `drawing` | `strokes`, `labels`, `background` | — |
| `formula` | `latex` | — |
| `code` | `source`, `language` | — |
| `html` | `html`, `screenshot`, `alt` | `caption` |

* **Text:** `content` is a rich doc as above. Optional `padding` is a
  nonnegative `Length`; omission is zero unless decorated, when rendering uses
  `0.75em`. Optional `decoration` is exactly
  `{kind:'left'|'box',color:PairColor}`. Omission means no decoration; do not
  store `null`. A Left or Box border uses the Strong tone and its background
  uses the paired Soft tone. The pair color is one of `primary`, `secondary`, `red`, `amber`,
  `green`, `pink`, `blue`, `violet`, or `gray4`; Gray 4 pairs with Gray 5.
  Text has no `background` or `borderColor` field.
* **Table:** a single constrained table doc, optional style and header-row
  settings, and optional owned caption. Omitted style means `simple`; omitted
  `headerRow` means false. Cell paragraph styling is fixed.
* **Image:** `src` is embedded image data, not a path or remote URL. `alt` is
  accessible descriptive text. Image dimensions derive from its intrinsic
  ratio and saved layout width. An image may own a caption.
* **Drawing:** layout height is positive. `strokes` is an array of
  `{points:[[x,y],...],color,width}`; a stroke has at least one finite point
  relative to the drawing's top-left, a fixed palette color, and positive
  document-pixel width. `labels` is an array of `{x,y,text,color,size}` with
  finite positions relative to the same top-left, positive document-pixel
  size, and fixed palette color. `background` is `"gray6"` or `null`.
  Resizing scales point/label positions but preserves stroke widths and label
  font sizes.
* **Formula:** `latex` is the source string; the renderer is KaTeX. There is no
  saved height.
* **Code:** `source` is exact plain text and `language` is a safe identifier
  matching `[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}`. The editor offers
  `javascript`, `typescript`, `python`, `json`, `html`, `css`, `shell`, `sql`,
  and `plaintext`. Code syntax colors follow `appearance.mode`, not the saved
  hues. Code is never a paragraph class, has no saved height, and is not
  executed.
* **HTML:** `html` is authored widget source, `screenshot` is embedded saved
  image data, `alt` is accessible description, and layout height is positive.
  The source is rendered only in the existing sandboxed widget boundary.
  HTML may own a caption; exports/minimaps use the saved screenshot where
  applicable rather than executing source.

Captions belong only to image, HTML, and table objects. The exact shape is
`{content: CaptionDoc, width?: number}`, where the optional width is positive
document pixels. With no width, it follows the owner; explicit width remains
fixed when the owner is resized. Captions are centered below their owner and
may overhang within the page. They have no own object ID, layout, position,
placement, or detach state. Caption selection/editing and width controls are
separate from the owner; deleting or cutting only a caption leaves its owner.

## Validation, limits, and interchange

Validation is strict over the received JSON. Unknown fields are rejected; do
not normalize untrusted input through ProseMirror before validation. Editor
output adapters may remove only defaults they themselves introduced (such as
non-list `listLevel: 0` or table cell span defaults); they must not silently
drop unknown imported data. No generic trimming, newline rewriting, or
compatibility normalization is allowed.

Identifiers are limited to 128 characters; strings are limited to 8 Mi
characters, except `alt` (4096 characters) and `authoring.aiModel` (256
characters; no control characters).
Documents are limited to 100,000 nodes and depth 100. Image data is embedded
as PNG, JPEG, WebP, GIF, AVIF, or safe inert SVG, with at most 10 MiB decoded
per image; PNG signatures are checked. Drawings allow at most 10,000 strokes,
100,000 total points, 1,000 labels, and 4,096 characters per label.

Native `.mote` files contain the V1 document and embedded assets; native saves
preserve `authoring`. Public projection validates the document and returns a
clone without `authoring`. Standalone HTML likewise omits `authoring` from its
reimport payload. Unsupported or corrupt imports do not replace the open
document. Cloud loading and publication never reset unsupported content.

Clipboard segment/object payloads are transfer envelopes, not saved documents.
They use `version:1`, `type:'segment'|'objects'`, and `objects` (never
`floating`) for object records. A segment carries `content` blocks and
`objects`; an objects payload carries its selected Flow blocks and `objects`.
Transient `geometry`, `anchorTops`, and `originTop` may accompany these
payloads for placement/coordinate translation. They are not fields of
`MoteDocument` or object `layout`. Main block/object/caption records inside
these envelopes use the V1 shapes above.
