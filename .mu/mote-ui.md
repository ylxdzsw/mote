---
name: mote-ui
description: Use when designing, implementing, or reviewing Mote UI, including layout, styling, controls, dialogs, canvas interactions, and interface copy. Provides design principles and existing patterns for a coherent document workspace.
---

# Mote UI design

Mote should feel like a quiet place to work on a document. The page carries the expression; the interface supplies orientation, useful tools, and trustworthy feedback. Aim for simplicity, unification, and continuity across writing, spatial composition, reading, and AI assistance.

Use these principles to make design choices, not as a frozen component specification. Existing patterns are a starting point. A new interaction or visual treatment can be appropriate when it makes the task clearer; explain the tradeoff and keep neighboring behavior coherent. Exact current behavior and product boundaries live in [AGENTS.md](AGENTS.md), [README.md](../README.md), and [CLOUD.md](../CLOUD.md). This guide does not turn stylistic preferences into validation rules.

## Let the document lead

Keep chrome visually quiet and let authored content supply most of the visual variety. Favor a continuous working surface, restrained borders, modest corners, and whitespace that makes relationships legible. Use elevation where it explains layering, such as a menu or dialog. A card is useful when it groups a real choice or composition; it need not surround every property group.

The main header, panels, text tools, and minimap share the document's page background; the exposed canvas surround stays neutral. Editing outlines, guides, and handles explain the current interaction and recede when it ends. Reading and export present the authored page without editing controls.

## Give each action an understandable home

Organize by what the user is doing and what the action affects. Extend an existing place before adding another entry point or mode.

| User intent | Current home and design rationale |
| --- | --- |
| Create content | Add / right-click launchpad: one coherent creation vocabulary |
| Format native rich text | Fixed Text strip: short, stable access to frequent formatting |
| Change the selected object or caption | Context: properties stay with their target |
| Work with an AI reservation | Assistant: request, access, and review stay together |
| Find or manage a document | Title → Files: search and opening lead; row actions handle maintenance |
| Change wider settings | Settings → Document / Workspace / Browser: scope is explicit |
| Share or export | Share → Link / Export: related outcomes in one dialog |
| Navigate or keep scratch material | Left minimap/bookmarks; Notes overlay below the canvas |

Make scope visible through selection, headings, and grouping. For example, caption width belongs in Caption properties; global Caption typography points to the document theme. Flow/Float placement uses the same control across object kinds. Right-click creation remains separate from object actions, with native text and editor-specific contexts preserved.

## Preserve the user's place

Stable geometry and focus are part of the visual design. Opening a menu, changing a panel tab, or receiving an AI result should not casually move the page, change its zoom, or steal the caret. The right Context/Assistant lane stays the same width across its tabs; Settings and Notes avoid resizing the canvas. Read/Edit retains its position.

Distinguish navigation from intent to edit. Scrolling preserves the active side-panel tab; selecting a reservation opens its task; opening Assistant preserves canvas selection for review. Let direct manipulation preview its effect, support cancellation, and commit as a coherent undo step. Selection outlines should make the target clear, especially for owned subobjects such as captions.

## Build hierarchy with restraint

Start with a clear heading, a useful grouping of controls, and a recognizable next action. Use alignment, spacing, weight, and subtle dividers before adding more containers or colors. Compact controls should still be readable and easy to target; density is useful when it reduces travel without hiding meaning.

Reuse the existing sans-serif UI typography and outline icon vocabulary. Document typography remains theme-driven. Use stronger accent treatment for the main action or selected state and quieter treatment for supporting actions. Flat icons work for familiar header actions with tooltips and accessible names; less familiar choices benefit from visible words. Destructive styling belongs to the destructive action, without making an entire panel alarming.

Choose controls that explain the decision: tabs for related views, a segmented choice for a small set of mutually exclusive modes, a checkbox for permission, a select for a longer list. These are useful precedents, not a requirement to fit every future choice into the same shape.

## Use shared colors by meaning

Use the existing `--ui-*` roles and [theme derivation](../src/theme/ui.ts), rather than inventing a palette for each feature. Common roles include `--ui-surface`, `--ui-surface-raised`, `--ui-ink`, `--ui-muted`, `--ui-border`, `--ui-accent`, and the hover/selected/focus and semantic-status variants.

UI accents follow the document Primary hue with controlled tones and readable contrast; Secondary colors document content. The saved Light/Dark mode controls both the fixed page surface and the interface. Main surfaces follow the page background, while surrounding workspace tones stay achromatic. Keep error, warning, and success meanings distinguishable. Check selected-plus-hover and keyboard focus as well as the idle state, in both Light and Dark appearance.

Keep document colors and UI colors conceptually separate. Authored marks and object decorations use document palette references; the interface uses readable UI roles. Swatches and previews should show the authored result faithfully. Improving chrome contrast should not silently recolor the user's content.

## Reveal detail where it helps

Keep frequent, decision-relevant controls visible. Move longer explanations and rare instructions into contextual help, without burying a state the user needs to act on. The compact Assistant, for example, keeps executor and workspace-read permission visible, puts routine explanations in tooltips, and displays pending confirmation or external-access notices directly.

Use short labels and concrete verbs: “Add caption,” “Match object width,” “Save settings.” Avoid repeating the heading in a subtitle or giving every control a paragraph of explanation. Empty states should orient the next action. Errors should say what happened, what was retained, and what the user can do next. Technical details belong in recovery downloads or diagnostics unless they help a product decision.

Quiet feedback must still be truthful. Local saving is not cloud synchronization; pending permission is not confirmed permission; a candidate preview is not accepted content. Favor undo for ordinary document edits. Use confirmation where the existing workflow protects a consequential operation, such as deleting a file, resetting content, or revoking active sharing.

## Make the same design usable across inputs and sizes

Keyboard focus, accessible names, selected/disabled states, and focus restoration are part of the component. Prefer native button, input, radio, and dialog behavior where it fits. Color and hover alone should not carry essential meaning. Tooltips complement visible state and accessible descriptions.

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
