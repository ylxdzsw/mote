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

## 2026-09-08 — Visual-scrollbar minimap and global view settings

User chose faithful page proportions as the default minimap behavior, with an optional whole-document fit mode if they share implementation. “Previewable” means content visible inside the strip, explicitly no hover popup. Navigation is vertical only, preserving horizontal scroll even when zoomed in. Small screens, especially mobile reading, hide it by default.

Both modes share an inert snapshot of the actual rendered sheet, preserving wrapping, semantic theme, spacers, and floating-box composition without extra Tiptap instances. Proportional mode scrolls the miniature as the document scrolls; fit mode compresses the vertical axis only when needed, never stretching short notes. The overview includes reachable right-side overflow in its width and uses canvas scroll extent for vertical mapping; the app footer itself is not drawn. Unreachable negative overflow remains an existing canvas limitation. Zoom affects the viewport indicator rather than the document miniature's scale. Pointer navigation preserves editor focus/selection; keyboard access uses the scrollbar itself. Native scrolling remains available.

Global settings temporarily live in the right sidebar, separate from document/theme settings and persisted in localStorage (`mote-view-settings`), not V0 or the document undo history. Visibility is Automatic/Show/Hide; Automatic shows only above 1050px viewport width. Explicit Show also works on mobile. Reading mode has a View button for the global-settings sidebar, overlaid rather than squeezing the canvas on mobile. A full configuration dialog remains future work.

The initial renderer refreshes its DOM snapshot on content/layout changes, coalesced per animation frame; scroll-only work translates the existing snapshot and viewport overlay. It duplicates static layout, not editor instances, but is not a tiled/virtualized renderer for extremely large documents.

Deployed after production-build and scoped Chromium checks, including a 60-section spatial note, theme/width reflow, live box dragging, keyboard/pointer navigation, and mobile opt-in/default hiding. Assets were copied before atomically replacing the live HTML; previous assets were retained for already-open clients, with a rollback copy at `/tmp/mote-before-minimap.VTYgSm/site`. Public HTML/JS/CSS matched the build and returned `Cache-Control: no-store` (Cloudflare DYNAMIC/BYPASS). Desktop and fresh mobile reading were smoke-tested on the live site.

## 2026-09-08 — Left-side minimap, no native canvas scrollbars

User requested the minimap moved to the left and the native scrollbar removed. The canvas now hides both native scrollbar tracks without disabling scrolling, including when the minimap is hidden on small screens. Wheel/touch/trackpad scrolling and minimap navigation remain; settings-panel scrollbars are unchanged. The minimap stays in its own left column, and zoom controls stay at the canvas's bottom right. This supersedes the initial decision to retain a visible native canvas scrollbar.

## 2026-09-08 — Header zoom, heading bookmarks, longer example

User requested the scale indicator in the top bar between saving and mode selection, small bookmark-like heading labels to the right of the minimap, and a demo three times longer. The full zoom control group now lives in a header portal, keeping document zoom ownership and focal-point behavior inside the canvas. Mobile keeps compact zoom controls and an accessible save message represented visually by its status dot.

Bookmarks cover every semantic `heading`, including floating-box headings, ordered by measured vertical position; `title` remains a separate semantic class. A dedicated narrow lane to the right of the miniature avoids covering document content. Labels track the same geometry in both sizing modes, preserve text selection/horizontal scroll when clicked, and highlight the last heading passed at the top of the viewport. Close labels are spread vertically without changing their targets; unusually dense visible headings can scroll within the bookmark lane. Headings outside a scrolling proportional miniature are hidden until their region appears. Bookmarks are derived view state, not saved document data.

The example now has three composed sections, 27 main blocks instead of nine, and three anchored notes instead of one, measuring about 2700px instead of 900px at the default theme/width. Existing IndexedDB drafts are never replaced by an updated example; users can load it through the existing confirmed Reset to example action.

Reading-mode Fit remains reachable below the normal 25% zoom floor when the available canvas is very narrow (for example, explicitly showing the minimap and bookmarks on mobile). The effective lower limit is the smaller of 25% and the reading fit scale.

Deployed after build and scoped browser verification, including a 71-heading long-document fixture, responsive header checks, and preservation of existing drafts. Live desktop reports 27 main blocks, three floating notes, 11 heading bookmarks, and 2699px page height; live mobile retains header zoom and hides the minimap by default. Public HTML/JS/CSS matched the build with no-store headers. Rollback copy: `/tmp/mote-before-heading-bookmarks.igKw0C/site`.

## 2026-09-08 — Main-text bookmarks and an inset reading focus

User requested earlier current-heading activation, main-text-only labels, half-width labels, and label text reduced by 1px. The activation line is now 15% down the canvas viewport, capped at 120 CSS pixels, independent of document zoom. Bookmark clicks align the heading to the same line so the selected destination becomes current without first reaching the top edge. Only semantic headings inside the main text contribute labels; floating content remains visible in the miniature but never contributes bookmarks or current-heading selection. The label lane is halved from 128px to 64px on desktop and from 88px to 44px on mobile, with 9px text (previously 10px), tighter padding, and full text retained in tooltips/accessibility names. These decisions supersede the initial floating-heading inclusion and near-top activation behavior.

Built, browser-checked, and deployed: activation switches on either side of the 120px line, short viewports use the 15% offset, bookmark jumps land on that line, both sizing modes retain eight main-text labels for the demo, floating notes remain drawn, and explicit mobile minimaps use 44px labels with 9px text. Live assets match the build with no-store headers. Rollback copy: `/tmp/mote-before-compact-bookmarks.AR7deK/site`.

## 2026-09-08 — Zoom presets and overlay bookmarks

The current zoom percentage is now a native preset dropdown (25%, 50%, 75%, 100%, 125%, 150%, 200%, 300%), replacing the separate reset button. Reading mode keeps Fit inside the dropdown; continuous zoom and Ctrl/⌘ 0 remain available. Arbitrary gesture/button scales still display their current rounded percentage.

Bookmark labels no longer reserve horizontal space: only the miniature strip has a layout column, and the document centers in the remaining canvas without considering label width. The existing 64px/44px labels overlay that canvas and may cover the document. Only actual labels intercept pointers; gaps pass through to the document. Dense labels remain independently wheel-scrollable. This supersedes the earlier dedicated non-overlapping bookmark lane decision.
