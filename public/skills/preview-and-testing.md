# Preview and test Mote candidates

Preview HTML widgets outside any authenticated Mote page. The shared harness uses the same opaque-origin `iframe sandbox="allow-scripts"` boundary as Mote widgets, without `allow-same-origin`; it is not an authenticated editor and does not save or submit the candidate.

The public, unversioned helpers are `/skills/helpers/preview.mjs` and `/skills/helpers/preview-harness.html`. They contain no task data and are not tied to a task grant. For an external task, download both files to the same local directory; a built-in task may use the task-brief copy or fetch these public files. Keep the helper and harness together because the helper reads its adjacent harness file.

With Node.js, make a local preview file from the candidate HTML and open it in a browser:

```sh
node ./helpers/preview.mjs ./output/widget.html ./output/preview.html
```

Open the generated file with `?width=WIDTH&height=HEIGHT`, for example `file:///path/to/output/preview.html?width=500&height=300`. Set the browser viewport to exactly those dimensions, exercise the promised interaction, and capture only the widget body—not browser chrome, caption, margins, or surrounding page.

- For an individual HTML object, use its rounded body `layout.width` × `layout.height` from the immutable snapshot.
- For a segment, capture each HTML object's own rounded body dimensions, not the segment rectangle or full page.

Save a real PNG in the task output directory and submit its bytes with the candidate. A screenshot is not an HTML URL, server path, placeholder, or substitute for the widget source. Candidate validation does not execute HTML or capture an image for you. Use the saved screenshot for minimap/PNG rendering.

The harness isolates the widget from the editor origin but is not a general hostile-code browser sandbox: candidate code may still request external resources. Inspect code and network dependencies, avoid secrets in the preview environment, and never preview untrusted candidate HTML on an authenticated Mote origin. For non-HTML native objects, validate the saved content and inspect the supplied snapshot; a browser screenshot is not required unless the task specifically asks for an HTML widget.
