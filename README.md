# Mote

A local-first demo exploring semantic text and anchor-relative spatial placement.

## Run

Use Node.js 22.12+ (or a current release) and npm.

```sh
npm install
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173` (it selects the next port if occupied). The development server listens on all interfaces for previews; do not expose it as a production server. Keep the same origin between sessions to access the same local draft.

```sh
npm run check   # TypeScript
npm run build   # TypeScript + production bundle in dist/
npm run preview
```

## First working slice

- One V0 document, initially an editable example with three text-and-space sections, 27 main blocks, and three floating notes. Existing browser drafts are preserved; **Reset to example** loads the current demo after confirmation.
- Semantic paragraph classes (`title`, `heading`, `body`, `caption`) and phrase classes (`emphasis`, `term`). No direct selection styling.
- Central theme controls shared by main and floating text.
- Explicit vertical spacers with adjustable height.
- Rich-text floating boxes anchored to main-text blocks. Drag a box’s border to move it; click inside to edit text. Selection reveals the resize and delete controls. Focused boxes move with arrow keys (Shift for 1px), and the resize control supports left/right arrows. There is no separate anchor handle or marker.
- Configurable document width, initially 800px.
- A live minimap on the left of the canvas shows text, semantic colors, whitespace, and floating boxes. Click a region to navigate or drag the shaded viewport to scrub vertically; horizontal position and editor selection are preserved. Wheel scrolling and keyboard arrows, Page Up/Down, Home/End work over the minimap. There is no hover popup. Native canvas scrollbars are hidden; wheel, touch, and trackpad scrolling remain available.
- Small main-text heading bookmarks sit to the right of the minimap in a 64px overlay (44px on mobile when explicitly shown), with 9px text. Labels take no horizontal layout space and can overlap the centered document; gaps between labels let clicks through. Floating notes remain visible in the miniature but do not contribute bookmarks. The current heading changes at a focus line 15% down the canvas viewport, capped at 120px; clicking a label aligns its heading to that line without changing horizontal position or text selection. Labels follow live edits and the miniature's scroll position; nearby labels spread out to stay readable. A very dense bookmark overlay can scroll independently over its labels. Full heading text is available in each label's tooltip and accessible name.
- Global settings in the right sidebar offer faithful-proportion (default) and fit-whole-document minimap sizing, plus automatic/show/hide visibility. Automatic hides at viewport widths of 1050px and below, including mobile. Reading mode exposes these settings through **View**. Preferences live in browser-local storage, separately from the V0 document.
- Fixed app frame with independently scrolling document canvas and settings. Zoom controls live in the top bar between save status and the mode selector. Click the current percentage to select 25%, 50%, 75%, 100%, 125%, 150%, 200%, or 300% (plus Fit in reading mode). Zoom only the document using these controls, Ctrl/⌘ + wheel, pinch, or Ctrl/⌘ +/−; Ctrl/⌘ 0 resets the view. Zoom is view state, not saved document geometry.
- Desktop editing/reading modes; viewports under 768px are reading-only. Entering reading mode fits the entire page width to preserve spatial relationships; document zoom remains available.
- A single browser-local draft in IndexedDB, written after each document update. Save errors are visible and retryable.

Click a main-text block before adding a space or an anchored text box. Spaces span the page up to its border, including the text margins. They are transparent when unselected; selection shows only 1px top and bottom lines. Click anywhere in a space to select it and adjust its height in the settings panel. Floating text uses the same semantic toolbar and theme as main text.

## Model and boundaries

`MoteDocument` contains a `version: 'V0'`, width, theme, main-text editor JSON, and floating objects. Each main-text block has a stable UUID. Each floating object stores an anchor UUID, x/y offsets in document pixels, width, and rich-text content. Its rendered position is derived from the anchor’s current layout, not saved as an absolute page position.

When an anchor is deleted, its floating objects move to the closest surviving preceding block, or the first remaining block. Their text is retained. Undo/redo currently covers text and spacers within each editor, **not** theme, geometry, reset, or box creation/deletion. V0 has no compatibility or migration promises yet.

IndexedDB (`mote-local` → `drafts` → `current`) is origin-specific local storage, not a backup. Another browser, port, hostname, or device has a different draft. Clearing site data removes it, and browsers may evict it. There is no cloud sync, multi-tab conflict resolution, import/export, or document library.

The floating layer deliberately permits overlap. Changing document width does not rewrite saved offsets; moving boxes beyond the page or shrinking the page can leave content outside its bounds. This demo does not yet have collision avoidance or a full spatial layout inspector.

## Structure

```text
src/app/        application shell, controls, responsive styles
src/document/   V0 data model, example, IndexedDB
src/editor/     constrained Tiptap schema and editor component
src/canvas/     anchor measurement, floating text interaction, zoom, minimap
src/theme/      shared semantic theme variables and controls
```

The minimap shares the rendered page through an inert, noneditable DOM snapshot, with editing controls and accessibility duplicates removed. Both sizing modes share this renderer and navigation geometry. Proportional mode keeps the page's aspect ratio and scrolls the miniature for long notes; fit mode compresses only the vertical axis as needed. Main-document zoom changes the viewport indicator, not miniature content scale. Scroll-only updates translate the existing snapshot and indicator; layout/content changes refresh the snapshot once per animation frame.

## Deployment

The current demo is live at **https://mote.ylxdzsw.com**. It is served as static files by Nginx from `/var/www/mote`, with the virtual host in `/etc/nginx/conf.d/mote.conf`. The existing wildcard Cloudflare Origin CA certificate covers the hostname. It is intentionally public and unauthenticated: there is no server API, session, account, or cloud document storage.

The deployment sets `Cache-Control: no-store` and disables Nginx ETags/expiration for HTML, JavaScript, CSS, and fallback responses. Cloudflare receives the origin directive and currently reports `DYNAMIC`/`BYPASS`, so the pre-release build is not cached at the edge. There is no service worker. Intentional IndexedDB document persistence is separate from HTTP caching. Future updates require `npm run build`, copying `dist/` to `/var/www/mote`, then `nginx -t && systemctl reload nginx`.

Vite development and preview responses also send `Cache-Control: no-store`. `public/_headers` carries the same rule for static hosts that support that format. Other hosts must explicitly set `Cache-Control: no-store` on **all** responses, including HTML and built assets.

Review the early-development decisions in `.mu/AGENTS.md` before a release.

## Verification

The initial slice was checked with `npm run build` and scoped Chromium browser checks: paragraph/phrase classes, text undo, unique IDs on paragraph splitting, anchor-following after text reflow, spacer insertion/resizing/deletion, box insertion/dragging/keyboard resizing, shared theme updates, IndexedDB reload persistence, simulated save failure and retry, and reset. Desktop reading preserves geometry; mobile initial load and resizing remain read-only with a scaled page. The production bundle was smoke-tested, with no-store headers verified on HTML and JavaScript. There is no automated regression suite yet.

The minimap was checked against a 60-section spatial note: proportional and fit geometry, click/drag navigation to the end, keyboard navigation, preserved text selection, vertical-only wheel handling, zoom independence, live text and box-drag updates, no cloned editor controls or duplicate DOM IDs, and snapshot reuse while scrolling. Settings persist across reloads and are accessible in desktop reading mode and mobile; automatic visibility was checked on desktop, small screens, and mobile, including explicit mobile opt-in.

Header zoom and heading bookmarks were checked with the 2699px demo and a 71-heading fixture: live heading renaming and semantic-class changes, floating-heading drag updates, selection/horizontal-position preservation on bookmark jumps, keyboard activation, proportional offscreen labels, dense fit-mode labels, and repeated sizing changes without duplicate buttons. The header was checked at 1440px, 768px, 390px, and 320px; mobile Fit also works below 25% when the minimap is explicitly shown. Reloading retains an existing draft, while confirmed reset loads all 27 example blocks and three notes.
