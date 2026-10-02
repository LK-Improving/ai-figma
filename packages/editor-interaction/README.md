# `@miaoma/editor-interaction`

Pure geometry and interaction helpers for the v1 design DSL. The package accepts `DesignDocument` and `DesignNode` values but never mutates a document, touches the DOM, or persists edits. The caller remains responsible for command validation and revision commits in Main.

Node bounds use parent-Frame local coordinates. A node's rotation (degrees) and scale pivot around the center of its bounds. `getNodeLocalToWorldMatrix(node, parentContentToWorld)` maps the node-local box `[0, width] × [0, height]`; pass a Frame's returned matrix as the parent-content matrix for each child.

Viewport pan, zoom anchors, client positions, and DOMRect origins are CSS pixels. `clientToWorld` subtracts the canvas DOMRect origin once, then applies the inverse pan/zoom. DPR is applied only by `canvasCssToBackingStore`/`clientToBackingStore`; `backingStoreToWorld` divides by DPR before applying the viewport inverse. Hit testing and marquee selection take browser client coordinates, never backing-store coordinates.

The main API is:

- `createViewport`, `panViewportBy`, `zoomViewportAt` for viewport state.
- `clientToWorld`, `worldToClient`, `clientToBackingStore`, `backingStoreToWorld`, `worldToBackingStore` for coordinate conversion.
- `getNodeLocalToWorldMatrix`, `getNodeWorldBounds`, `hitTestDocument`, `nodesIntersectingClientRect` for transformed geometry, topmost-first picking, and marquee selection.
- `updateSelection`, `keyboardNudgeDelta` for selection and arrow-key deltas.
- `createDragDraft`, `updateDragDraft`, `commitDragDraft` for draft-only movement; grid snapping is measured in parent-local design units. Commit returns a descriptor with `baseRevision`; it does not write the document.

Point picking uses the transformed ellipse curve and box hit regions for frames, rectangles, icons, and text. Marquee selection uses transformed node boxes, and clips against every clipping ancestor. Hidden nodes and locked subtrees are ignored by default; pass `{ includeLocked: true }` for a layer-panel workflow that permits selecting them.

Build after the workspace links the package dependency, then run `node self-check.mjs`. The self-check covers DPR round-trips, zoom anchoring, nested transforms, z-order, ellipse/box picking, clipping, lock/visibility filtering, marquee, drag/snap/commit, multi-selection, and nudge deltas.
