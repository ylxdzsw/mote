# Mote document formats V1–V3

This is the normative specification for native Mote documents. `format` is
exactly `"mote"`; `version` is the number `1`, `2`, or `3`. V1 is the original
continuous-page format. V2 adds Slides; V3 adds optional table color pairs.
All other shapes and meanings are shared. Unknown versions and unknown fields are rejected;
there is no extension bag or implicit compatibility mode.

## Versioning and migration

Every schema or meaning change, additive or not, gets a new version. Versions
are cheap: a closed schema needs the bump so that older app builds and stale
tabs reject newer documents clearly instead of dropping fields on save, and so
that a task's pinned version states exactly what its agent saw. V1 is the
oldest supported version; V0 is permanently unsupported and has no converter.

The single load boundary is `loadDocument(value)`. It reads `version`, applies
the ordered migration steps from that version to the current one, and then
validates the result with the closed validator of the current version. Every
reader uses this path: editor, Files/import, public share, standalone HTML
reimport, indexer, and server validation. No other code interprets an older
shape. Steps are pure and lossless. They preserve block, object, and rich-text
IDs and keep the meaning of the content. A lossy rearrangement (such as Slides
partitioning) is a confirmed user edit, not a migration.

Each step declares whether it is **breaking**. A step is non-breaking only if
every valid old document and every valid old candidate remains valid under the
new version with the same meaning, so that the step only changes `version`.
Typical examples are a new optional field whose absence keeps the old
behavior, or a new enum value or object kind. Removing or renaming a field,
changing a default or meaning, adding a required field, or tightening
validation is breaking. A migration path is breaking if any of its steps is.

| Step | Breaking | Effect |
| --- | --- | --- |
| V1 → V2 | No | Sets `version: 2`; no `slideHeight`, so Slides stay off |
| V2 → V3 | No | Sets `version: 3`; omitted table colors retain prior styling |

Migration happens in memory. Loading never writes by itself. The next ordinary
revision-checked save persists the upgraded document, and readers that cannot
save (public shares, standalone HTML) migrate only their own snapshot. The
pre-migration document remains recoverable until the upgraded save is
cloud-acknowledged. A newer or unknown version, or malformed data, produces an
actionable error and remains unchanged and recoverable. It is never replaced
with an example. A failed or unsupported import leaves the current document
untouched. **From example** remains an explicit New File choice.

Unresolved AI tasks keep their pinned input version. Under a non-breaking
path, they keep working. Their candidates validate against the pinned version
and pass through the same steps when accepted. Under a breaking path, opening
a document that has unresolved tasks asks the owner first. **Upgrade**
releases those tasks, permanently revokes their grants, and then migrates.
**Decline** opens the document read-only at its stored version, with its tasks
and candidates inspectable and the full task JSON downloadable. Without
unresolved tasks, a breaking path migrates silently. Generation is never
retried automatically. The agent transport identifier `mote-agent-v1` is a
separate protocol version and does not replace the document's numeric
`version`.

V1 and V2 load as V3; V1 keeps Slides off. New documents, saves of opened documents,
exports, and new task inputs use the current version. `validateDocument`
still accepts every supported version, so pinned task snapshots and stored
revisions stay readable as they are.

## Top-level document

The exact top-level shape is:

```ts
type MoteDocument = {
  format: 'mote'
  version: 1 | 2 | 3
  id: string
  language: 'en' | 'zh-Hans'
  page: {
    width: number                 // document pixels, > 0
    margins: Insets               // document pixels, all sides >= 0
    slideHeight?: number          // V2+ only; positive finite document pixels
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

### Slides (V2+ only)

Presence of `page.slideHeight` activates Slides; omission means continuous
layout, including in V2. The default height on enabling is 540px; any positive
finite height is allowed. The first slide is implicit. Subsequent slides
start at top-level `{type:'slideBreak',attrs:{id:string}}` atoms in the same
flat `content` array. A marker belongs to the slide it starts. There is no
separate slide ownership field or nested content container. Each slide has
at least one content block; an empty slide uses an empty paragraph, never a
leading/trailing marker or adjacent markers without intervening content.

V1 rejects both `slideHeight` and `slideBreak`. V2 without `slideHeight` also
rejects markers. Each marker has only `type` and `attrs`, whose only key is a
globally unique `id`. Markers cannot occur inside objects, captions, or tables.
Paragraphs, Flow atoms and their owned captions remain whole compositions.
Floats belong to the slide of their anchor: null means the first slide top;
a marker ID means that subsequent slide's top; paragraph, spacer and Flow
anchors belong to their containing slide. Marker-relative Float x is in page
coordinates and y is nonnegative, just like document-top positioning.

Enabling Slides partitions at Title/Heading paragraphs (not Subheading), and
packs whole blocks to the requested height using measured bounds when
available and estimates otherwise. A leading heading does not create a blank
slide. A single oversized block is retained intact. Automatic partitioning
happens only on enabling; later height edits preserve boundaries. Inserting
a boundary or joining a slide with its predecessor preserves block/object
IDs, Flow anchors, and captions. Empty newly inserted slides receive writable
paragraphs. Float offsets are translated best-effort when their slide-top
anchor changes; ordinary paragraph/Flow associations stay intact. Disabling
Slides removes `slideHeight` and markers, concatenates content, and translates
marker-anchored Floats into continuous coordinates. The document keeps its version (V2 or newer).

A new document starts in Light mode with Primary hue 29°, Secondary hue 262°,
mixed-script autospace enabled, and a 16px Sans default in Gray 2 at weight
400. Its default line height is 1.5em, Before is 0em, After is 1em, and
letter spacing is 0em. New themes seed Title, Heading, Subheading, Body,
Caption, and List paragraph styles; Table, Code, and Formula object styles;
and Flow spacing of 1.5em Before and After. The seeded Subheading style is 1.125em at weight
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
paragraphs, explicit spaces, and Flow atoms, plus slide boundaries in V2+ Slides:

```ts
type MainDoc = { type: 'doc'; content: [MainBlock, ...MainBlock[]] }
type MainBlock = MainParagraph | Spacer | FlowAtom | SlideBreak // last case: V2+ Slides only
type MainParagraph = {
  type: 'paragraph'
  attrs:
    | { id: string; semantic: Exclude<ParagraphClass, 'list'> }
    | { id: string; semantic: 'list'; listLevel: number }
  content?: Inline[]
}
type Spacer = { type: 'spacer'; attrs: { id: string; height: number } }
type FlowAtom = { type: 'flow'; attrs: { id: string; objectId: string } }
type SlideBreak = { type: 'slideBreak'; attrs: { id: string } }
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

Float `anchorId` is null (document/first-slide top) or a main paragraph, spacer,
Flow atom, or V2+ Slides marker ID. For document-top, slide-top and ordinary paragraph/space anchors, x is in page
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
| `table` | `content` | `style`, `headerRow`, `caption`, `color` (V3 only) |
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
  `headerRow` means false. V3 permits optional `color: PairColor`, using the same
  nine Strong/Soft pairs as text decorations. Simple uses Soft for the header;
  Business uses Strong for its header band/border and Soft for stripes. Academic
  ignores color but retains it. Omission preserves Gray 4/Gray 5 for Simple and
  Secondary for Business. V1/V2 reject `color`. Cell paragraph styling is fixed.
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
  `plaintext`, `c`, `css`, `html`, `javascript`, `python`, `rust`, `shell`,
  and `sql`. Other safe identifiers remain valid and render as plain text;
  loading does not rewrite the identifier or source. Code syntax colors follow `appearance.mode`, not the saved
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

Native `.mote` files contain the V1, V2, or V3 document and embedded assets; native saves
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
these envelopes use the current native shapes above; AI candidates must use
their task’s pinned native version. The transfer version is separate from the
native document version.

Slide-aware segment transfers use `version:2` with the same envelope fields,
permitting V2 `slideBreak` atoms. Ordinary clipboard segments remain version 1;
whole-slide clipboard uses its distinct `type:"slides"` envelope with
`documentVersion:2|3` declaring its native object schema. AI V2 segments
require a Slides document and retain internal boundaries in the reserved range.
The leading boundary may be omitted; application preserves the original boundary
IDs and remaps marker-anchored Floats. Empty candidates clear content without
removing slides. These transfer versions do not change the task transport protocol.
