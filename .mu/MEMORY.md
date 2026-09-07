# Development notes

## 2026-09-07 — First demo and scaffold

User confirmed that spatial objects are relative to anchors, and that the draft should be cached in browser-local datastores. The proposed stack was React + TypeScript + Vite with Tiptap/ProseMirror for rich text; implemented as a single-document browser application, without a backend.

The initial demo combines semantic paragraphs/phrases, a central theme, explicit vertical spacers, and anchored rich-text boxes. Main and floating text share the same semantic schema and theme. Native rich-text paste is constrained by the schema; no arbitrary inline CSS is retained.

V0 uses stable main-block UUIDs and floating-object anchor IDs plus document-pixel offsets and width. Anchor geometry is derived after layout and never persisted. If an anchor is deleted, retain its boxes and reanchor to the nearest surviving predecessor (or first remaining block). User confirmed this deletion behavior on 2026-09-07.

IndexedDB holds one current draft, including theme and spatial data. Writes are local document persistence, intentionally distinct from HTTP caching, which is disabled. Browser storage is not guaranteed durable and is not a backup. No cloud, import/export, document library, or migrations. Multi-tab editing is not coordinated yet.

Mobile means a viewport below 768px in this demo and forces reading mode. Reading scales the fixed-width page as a unit to retain the spatial composition. Desktop defaults to editing; document width starts at 800px. Width changes preserve offsets and do not automatically rearrange boxes. These responsive/width policies are implementation defaults to discuss further.

Undo/redo is per text editor (including main-text spacers); a unified document-wide history for theme/spatial changes is deferred. Reset and floating-box deletion ask for confirmation. Dependencies are locked with npm; no Git repository has been initialized.

## 2026-09-07 — Initial static deployment

User requested `mote.ylxdzsw.com` deployed through the existing Nginx and Cloudflare origin, with no authentication and no HTTP caching before release. It is a purely front-end static site; IndexedDB remains browser-local and no cloud service is involved. The deployment uses the existing wildcard origin certificate, a dedicated Nginx server block, and `Cache-Control: no-store` on all responses.

## 2026-09-07 — Document viewport and PPT-style box interaction

User requested page-level scrolling/zooming replaced by document-level interaction, chrome about 30% shorter, full-page-width transparent spaces with only selected top/bottom 1px borders, and removal of the anchor handle in favor of PPT-style border dragging. Desktop header/toolbar heights are now 50/37px (previously 72/53); mobile header is 45px (previously 64).

The app frame is viewport-bound. Canvas and inspector scroll independently; wheel/pinch and keyboard zoom gestures scale only the document, with explicit canvas zoom controls as well. Zoom is transient view state, not V0 document data. Entering a different editing/reading mode resets zoom to that mode’s baseline; reading fits the width, and users can zoom further. Document-pixel box offsets and widths remain independent of view scale.

Spaces extend through both text margins, but logical anchor origins stay at the main-text left margin so changing the spacer’s visual width does not shift anchored objects. No space label, fill, side border, or unselected decoration remains. Floating boxes retain their anchor model internally without an anchor marker or move handle. Drag their border/padding to move; text remains directly editable, and resize/delete controls appear only on selection. Border focus supports keyboard movement and deletion.

## 2026-09-07 — Version control

User requested Git initialization, a commit of the current project, and deployment. The initial repository snapshot includes the V0 application and document-viewport interactions. Build output, dependencies, environment files, and local agent sessions/objects are excluded; project guidance and development notes are tracked.
