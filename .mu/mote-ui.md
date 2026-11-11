---
name: mote-ui
description: Use when designing, implementing, or reviewing Mote UI, including layout, styling, controls, dialogs, canvas interactions, and interface copy. Provides design principles and existing patterns for a coherent document workspace.
---

# Mote UI design

Mote should feel like a quiet place to work on a document. The page carries the expression; the interface supplies orientation, useful tools, and trustworthy feedback. Aim for simplicity, unification, and continuity across writing, spatial composition, reading, and AI assistance.

Use these principles to make design choices, not as a frozen component specification. Existing patterns are a starting point. A new interaction or visual treatment can be appropriate when it makes the task clearer; explain the tradeoff and keep neighboring behavior coherent. Exact current behavior and product boundaries live in [AGENTS.md](AGENTS.md), [README.md](../README.md), and [CLOUD.md](../CLOUD.md). This guide does not turn stylistic preferences into validation rules.

## Let the document lead

Keep chrome visually quiet and let authored content supply most of the visual variety. Favor a continuous working surface, restrained borders, modest corners, and whitespace that makes relationships legible. A document may also use saved Slides boundaries without becoming a presentation editor: keep its layout controls in Document settings, show boundary/crop cues only while editing, and let reading/export present the authored slides without slide chrome. Use elevation where it explains layering, such as a menu or dialog. A card is useful when it groups a real choice or composition; it need not surround every property group.

The main header, panels, text tools, and minimap share the document's page background; the exposed canvas surround stays neutral. Editing outlines, guides, and handles explain the current interaction and recede when it ends. Reading and export present the authored page without editing controls. Slides presentation belongs to the shared reader, not a separate editor: a transient Present entry gives way to one fitted slide with its page background extended seamlessly to the viewport. Click/arrow navigation and Escape replace persistent presentation chrome, while links and widgets keep their normal interactions.

## Give each action an understandable home

Organize by what the user is doing and what the action affects. Extend an existing place before adding another entry point or mode.

| User intent | Current home and design rationale |
| --- | --- |
| Create content | Add / right-click launchpad: one coherent creation vocabulary; a local Add slide shortcut extends the layout at the Slides endpoint |
| Format native rich text | Fixed Text strip: short, stable access to frequent formatting |
| Change the selected object or caption | Context: properties stay with their target |
| Reserve content or work with an AI task | Combined right lane: Reserve follows ordinary properties; reserved selections show still-editable properties above Assistant |
| Find or manage a document | Title → Files: search and opening lead; row actions handle maintenance |
| Choose a document layout | Settings → Document: direct layout controls for continuous or Slides, with slide boundaries kept on the editing canvas |
| Change document typography and colors | Header Theme: a dedicated dialog for Defaults, Palette, and semantic styles; Context style shortcuts open the relevant section |
| Change wider settings | Settings → Document / Workspace / Browser: scope is explicit |
| Share or export | Header Share or Files row → Share → Link / Export: one dialog, scoped to its named document without requiring navigation |
| Navigate or keep scratch material | Left minimap/bookmarks; Notes overlay below the canvas |

Make scope visible through selection, headings, and grouping. For example, caption width belongs in Caption properties; global Caption typography points to the document theme. Flow/Float placement uses the same control across object kinds. Right-click creation remains separate from object actions, with native text and editor-specific contexts preserved.

## Preserve the user's place

Stable geometry and focus are part of the visual design. Opening a menu, changing a panel tab, or receiving an AI result should not casually move the page, change its zoom, or steal the caret. The combined right lane stays the same width across ordinary and reserved selections; Settings and Notes avoid resizing the canvas. Preview opens separately and leaves the editor in place. Readers share one chrome-free shell; mobile file choice happens before entering a document, not through a persistent reader toolbar.

Reading uses the browser's page scrolling and zoom, rather than inheriting the editor's controlled viewport. An initial width fit preserves authored wrapping; it must not continuously counteract browser zoom. The minimap follows window scrolling, while presentation temporarily fits one slide. Sharing document rendering does not require sharing editor viewport controls. Native printing hides reader navigation and leaves pagination to the browser.

Distinguish navigation from intent to edit. The right lane follows selection rather than a separate Context/Assistant mode. Unreserved content offers Reserve after its normal properties. Reserved content retains only properties that remain editable, followed by its Assistant task; reserved paragraphs and section compositions show the task alone. Keep these in one scrolling area so properties cannot crowd task actions out of a short viewport. Selecting content never reserves or starts generation by itself. The selected reserved area supplies task navigation, without a parallel task strip. Clearing canvas selection clears the task view; focusing the panel preserves its target. Background completion never takes over the current view, and a conditional Recovery disclosure keeps tasks without active reservations reachable. For current agent tasks, a newly arriving version never changes the owner's selected review version; the selected version is follow-up context, not lineage, and the UI syncs the owner document before sending that follow-up. Reservation controls preserve canvas selection, including gutter sections, for reservation and review. Accept and Discard return to normal properties for the remaining selection; Undo restores the reservation and its task view. Let direct manipulation preview its effect, support cancellation, and commit as a coherent undo step. Selection outlines should make the target clear, especially for owned subobjects such as captions.

## Build hierarchy with restraint

Start with a clear heading, a useful grouping of controls, and a recognizable next action. Use alignment, spacing, weight, and subtle dividers before adding more containers or colors. Compact controls should still be readable and easy to target; density is useful when it reduces travel without hiding meaning.

Editing is a desktop workbench, not a touch-first form. Use the shared control-height, radius, type, and panel-spacing tokens. Prefer aligned label/value rows for scalar properties, paired rows for related numbers, and content-sized supporting actions. Keep full-width writing surfaces for prompts, descriptions, and source. Gain density by reducing padding and redundant framing, not by shrinking labels into fine print. Segmented choices should have usable targets inside their outer border, not just a large surrounding container.

Reuse the existing sans-serif UI typography and outline icon vocabulary. Document typography remains theme-driven. Use stronger accent treatment for the main action or selected state and quieter treatment for supporting actions. Flat icons work for familiar header actions with tooltips and accessible names; less familiar choices benefit from visible words. Destructive styling belongs to the destructive action, without making an entire panel alarming.

Choose controls that explain the decision: tabs for related views, a segmented choice for a small set of mutually exclusive modes, a checkbox for permission, a select for a longer list. These are useful precedents, not a requirement to fit every future choice into the same shape.

## Use shared colors by meaning

Use the existing `--ui-*` roles and [theme derivation](../src/theme/ui.ts), rather than inventing a palette for each feature. Common roles include `--ui-surface`, `--ui-surface-raised`, `--ui-ink`, `--ui-muted`, `--ui-border`, `--ui-accent`, and the hover/selected/focus and semantic-status variants.

UI accents follow the document Primary hue with controlled tones and readable contrast; Secondary colors document content. The saved Light/Dark mode controls both the fixed page surface and the interface. Main surfaces follow the page background, while surrounding workspace tones stay achromatic. Keep error, warning, and success meanings distinguishable. Check selected-plus-hover and keyboard focus as well as the idle state, in both Light and Dark appearance.

Workspace overlays such as Files and Local recovery inherit the active working copy's theme even when mounted outside the editor shell. With no open document, they use the default interface appearance.

Keep document colors and UI colors conceptually separate. Authored marks and object decorations use document palette references; the interface uses readable UI roles. Swatches and previews should show the authored result faithfully. Improving chrome contrast should not silently recolor the user's content.

## Reveal detail where it helps

Keep frequent, decision-relevant controls visible. Move longer explanations and rare instructions into contextual help, without burying a state the user needs to act on. The compact Assistant keeps its local Built-in/External view tabs and task-owned workspace-read permission visible, with expiry and access details in context. The tabs are presentation only: they do not change authority or stop concurrent agents.

Use short labels and concrete verbs: “Add caption,” “Match object width,” “Save settings.” Avoid repeating the heading in a subtitle or giving every control a paragraph of explanation. Empty states should orient the next action. Errors should say what happened, what was retained, and what the user can do next. Technical details belong in recovery downloads or diagnostics unless they help a product decision.

Quiet feedback must still be truthful. Local saving is not cloud synchronization; an unsynced reservation property is not yet server authority; a candidate preview is not accepted content. Favor undo for ordinary document edits. Use confirmation where the existing workflow protects a consequential operation, such as deleting a file, resetting content, or revoking public sharing.

Routine successful actions should not create persistent page-wide banners. Let the changed document, existing sync indicator, or local control status communicate completion. Reserve persistent banners for actionable warnings, errors, and recovery needs; successful background work must not replace an unrelated warning. Accept and Discard are local, undoable document/reservation edits: neither performs a cloud preflight or immediate task-service request. A cached proposal remains previewable/acceptable during service failure. Ordinary sync is opportunistically debounced and final persistence still uses document revision CAS; conflicts retain local work through existing recovery.

## Make the same design usable across inputs and sizes

Prefer browser defaults and conventional editor behavior over specialized shortcuts or a parallel keyboard-operated canvas. Pointer geometry handles need not be Tab stops or have keyboard movement/resizing equivalents. Rich text deliberately owns Tab/Shift+Tab: Body-to-List conversion and list indentation remain, while ineligible paragraph classes and captions keep focus without changing content. Table cell navigation and source-editor indentation retain their established behavior; ordinary UI controls keep native focus navigation.

Keyboard focus, accessible names, selected/disabled states, and focus restoration are part of the component. Prefer native button, input, radio, and dialog behavior where it fits. Color and hover alone should not carry essential meaning. Tooltips complement visible state and accessible descriptions.

Account for the painted focus ring, not only the control's border box. Leave clearance from dividers and adjacent controls; use inset rings for tightly joined buttons, tabs, and list rows, with enough internal padding to keep the ring off the label. Compound numeric fields highlight the complete field while identifying a focused unit selector separately. Check keyboard focus at both ends of scrolling regions, since an otherwise well-spaced outline can be clipped when a control is scrolled into view.

At compact desktop sizes, preserve the user's task and action hierarchy. Let lists or panel contents scroll, keep critical actions reachable in short windows, and truncate long names with a way to inspect them. Mobile follows Mote's reading-only boundary; it should remain a considered reading/navigation experience. Keep document wrapping and spatial geometry independent of view zoom.

## Apply the guide to a change

1. Identify the user's task, the affected scope, and the closest existing interaction. Read the relevant implementation and search [MEMORY.md](MEMORY.md) for the latest rationale when a decision is unclear.
2. Reuse the nearest component and its visual roles. If the design needs a new pattern, make its purpose clear and consider whether it should improve related controls too; avoid unrelated redesign work.
3. Review the states that matter for this change: empty, selected, busy, unavailable, error, or recovery. Preserve focus, selection, and document geometry where the interaction relies on them.
4. For implementation changes, inspect the rendered result in the affected desktop/compact/mobile modes and theme conditions. Exercise keyboard behavior and the relevant cancellation/undo path. Choose scoped checks from README; this is not a demand for an exhaustive matrix on every edit.

Useful implementation references:

- [styles.css](../src/app/styles.css) and [ui.ts](../src/theme/ui.ts): shell, surfaces, controls, and theme roles.
- [Inspector.tsx](../src/app/Inspector.tsx), [FloatingInspector.tsx](../src/app/FloatingInspector.tsx), and [inspector.css](../src/app/inspector.css): headings, groups, text tools, and object properties.
- [PanelIcon.tsx](../src/app/PanelIcon.tsx) and [PaletteControl.tsx](../src/theme/PaletteControl.tsx): shared icons and fixed paired color choices.
- [App.tsx](../src/app/App.tsx), [FilesWindow.tsx](../src/cloud/FilesWindow.tsx), and [ShareWindow.tsx](../src/cloud/ShareWindow.tsx): stable shell, document switching, and dialog organization.
- [AssistantPanel.tsx](../src/ai/AssistantPanel.tsx): compact task controls, visible permission state, and review.

Keep this skill about reasons and reusable patterns. Update it when a design principle changes; keep exact dimensions, API rules, and feature inventories in their existing sources.
