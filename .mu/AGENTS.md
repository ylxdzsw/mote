Mote
====

## Status

The project is in early deveoplment phase.

1. Editing can be made directly without any backward compatibility;
2. Use V0 as document format version, which also does not maintain any compatibility; If saved draft failed to parse, pop up a dialog to reset to example
3. Disable caching on the deployment;
4. Redploy the demo after each task; no need to backup.

Review these before making actual release.

## Final Goal

A note taking web app, which emphasis simplicity, unification, and coherence. The main text is a rich text, with semantic styles (lines and characters can be put into semantic classes, but not directly styled; A global theme edits the style of each class). Vertical spaces can be inserted into the document. PPT-like spatical placement is a key feature, on top of the automatically layout main text.

## Guiding Rules and Key Decisions

- Has editing mode and reading mode. Moblie version only supports reading mode.
- Document width can be set in the document config editor, defaults to 800px.

## Planned Features

These features are planned but explicit not V1. They need rediscussion and design before implementation.

- Import and export Markdown or other formats.
- Cloud features, including save/load.
- Native bundled binary version.

## Development and Deployment

Node.js 22.12+ and npm. `npm install`, `npm run dev` (port 5173 or next available, all interfaces), `npm run check`, `npm run build`, `npm run preview`. Use the printed URL; IndexedDB drafts are origin-specific. `npm run test:ai` runs essential reservation/fake-backend invariants without model calls. Build and scoped Chromium checks are described in README.md; no general regression suite yet.

Deployed at `https://mote.ylxdzsw.com` through `/var/www/mote` and `/etc/nginx/conf.d/mote.conf`; static responses use `Cache-Control: no-store`. Ordinary editing/reading is intentionally unauthenticated. The optional `/api/ai` backend uses the existing Nginx cookie gate and `moted.service`, with per-task unprivileged systemd workers, private writable temporary paths, and read-only host/source access. Server code stays in `/root/mote/server`, not the public static directory. See README for fake-first testing, input/output contracts, model configuration, and operational boundaries. Dev/preview send `Cache-Control: no-store`; `public/_headers` supplies the same policy for supporting static hosts. Other hosts must configure no-store for HTML and assets. No service worker. Browser-local document persistence is intentional, separate from HTTP caching.

## File Structure

`src/app/`: shell, controls, CSS. `src/document/`: V0 model, example, IndexedDB. `src/editor/`: constrained semantic Tiptap schema. `src/canvas/`: measured anchors and floating rich-text boxes. `src/theme/`: central semantic styling. `src/ai/`: reservations, task state, service client, and review UI. `server/`: moted, worker isolation, guide, preview/delivery helpers, and fake runner. See README.md for demo boundaries.

## Dev Notes

Use .mu/MEMORY.md as the dev note. This file is generally append-only, with later notes supercedes previous notes. Edit this file while key decision or significant chagnes are made. Focus on discussions, decisions and designs, avoid recoding trivias like what edited in which file, which duplicates git log. Search this file for previous discussion and decisions before making new changes, to avoid accident regression.
