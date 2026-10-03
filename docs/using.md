# Using the viewer

[← README](../README.md)

Open files with File ▸ Open… or File ▸ Folder…, or by dropping them on the viewer, or with `?src=<url>`. Press **?** or **F1** for the Help window, which lists every key and mouse gesture. Keys work while the viewport or the hierarchy has focus, but not while you are typing in a field.

## Navigation and selection

| Input | Action |
|---|---|
| Left drag / right drag / wheel | Orbit / pan / zoom towards the cursor |
| `F` | Frame the selection, or everything |
| Click | Select one prim; clicking empty space clears the selection |
| Shift+click | Add a prim and make it the **active** one. On a prim that is already selected, it only makes it active |
| Ctrl+click | Remove a prim from the selection |
| Shift+Ctrl+click | Add the prim's parent. Each further Shift+Ctrl+click adds the next level up |
| Shift+drag **up** | Add everything the rectangle touches |
| Shift+drag **down** | Add only what lies fully inside the rectangle |
| Ctrl+drag | Remove from the selection, in the same two ways |

- The **active** prim has the brighter highlight. The property panel shows it, and the transform gizmo sits on it.
- With several prims selected, a dropdown above the property panel picks which one is shown.
- The rectangle tests screen-space bounding boxes, not exact outlines.

## Panels

- **Hiding panels.** The hierarchy, the property panel and the timebar each have a small tab in the middle of their border with the viewport. The tab appears when the pointer comes near that border. You can also use View ▸ Panels.
- **Resizing.** Drag a side border to resize that panel. Side panels keep their share of the window when the window is resized, and are never narrower than 120 px. The timebar keeps its height. Shares and visibility are remembered in the browser.
- **Timebar.** It has first / previous / play / next / last buttons, a frame field, the stage's range and fps, and a loop switch. `Space` plays, and `,` / `.` step one frame. The timebar is disabled for stages without animation.
- **Prim search.** The search field above the hierarchy filters by name, or by type with `type:Mesh`. Its ✕ button or Escape clears the search.

## Hierarchy symbols

| Symbol | Meaning |
|---|---|
| **P** | Has a payload; load or unload it in the property panel |
| **V** | Has variant sets; choose them in the property panel |
| **I** | Instanceable: drawn as an instance of a shared prototype |
| **◆** (orange) | Changed: its layer specs differ from the stage as it was opened |
| **◇** (orange) | A prim below it changed |
| ● / ○ | Visible / invisible. Clicking toggles it; the change is written to the edit target |
| 🔓 / 🔒 | Lock against selection in the viewport. This is editor state only and is never saved |

How change markers behave:
- The core keeps a snapshot of the local layer stack from when the stage was opened.
- Undoing an edit, or setting a value back by hand, removes the marker.
- Saving keeps the markers. Reloading or reopening takes a new snapshot.
- Viewer hiding (H keys) and edits made in the session layer do not count.

## Editing

Edits go to the stage's **edit target**. That is the root layer by default; File ▸ Edit target switches to a sublayer, or to the session layer, whose edits are never saved. Every edit is undoable with `Ctrl+Z` / `Ctrl+Shift+Z`.

- **Transforms**
  - `Q` is Select; `W` / `E` / `R` are Move / Rotate / Scale.
  - The gizmo sits at the active prim, and every selected prim follows it. Rotation and scale happen about the active prim's origin.
  - The objects follow the pointer at once, while each step is written to the prims' xform ops:
    - a translate / rotate / scale stack keeps its ops and precision;
    - a lone `xformOp:transform` is set directly;
    - anything else gets a leading `xformOp:transform:edit`.
  - Instances are moved as a whole.
- **Attributes, visibility, variants, payloads, refinement**: from the property panel or the hierarchy.
- **Hiding**
  - `H` hides the selection.
  - `Shift+H` hides everything else: the siblings along the selection's ancestors.
  - `Alt+H` shows what those hid.
  - These keys write `visibility` into the session layer, so the file never becomes dirty. Prims the file itself makes invisible stay hidden.
- **Clear edits**
  - Right-click a prim in the hierarchy or in the viewport ▸ **Clear edits**.
  - It puts the prim and everything below it back as they were when the stage was opened, as one undoable step.
- **Saving**
  - `Save` (`Ctrl+S`) writes each layer with unsaved edits in its own encoding (usda or usdc).
  - A folder opened with File ▸ Folder… in Chromium is written back in place, through the File System Access API. Otherwise the layer is downloaded.
  - File ▸ Download flattened exports the composed stage as one usda file.
  - Saving is an export: comments and formatting of hand-written usda are rewritten, and members of a usdz package cannot be written back.
- **Changes from outside.** When a folder was opened with write access, its USD files are checked every 2 s and re-read when another program changed them. With unsaved edits, the viewer warns instead; File ▸ Reload from disk discards those edits.

## Copying

Every value in the property panel sits in a box.
- **Click** a box to copy its value.
- **Right-click** to copy `value`, `name = value`, the typed usda declaration, or the whole section as text. Long arrays are copied in full, not as shown.

The prim menu (right-click) also copies the prim's USD, either the composed subtree or only what the edit layer authors, and its path.

## Display

- **Display modes** (toolbar):
  - **Shaded** uses the bound materials; **Plain** uses one grey material.
  - Either can be shown alone, with the edges of every mesh (**+ wire**), or with red edges on the selection only (**+ selection wire**).
  - **Wireframe** shows edges only.
  - Edges are the outlines of the authored faces: no triangulation diagonals, and on refined meshes only the cage faces.
- **Skies** (toolbar):
  - **Stage** (default): the stage's own dome light, or the background colour when it has none.
  - **Colour**: the stage's lighting in front of the plain background colour.
  - **Five HDRIs**: blue sky, sunset, forest, industrial hangar and studio. These are CC0 images from Poly Haven; see [`web/public/skies/LICENSE.md`](../web/public/skies/LICENSE.md).
- **Background colour**: View ▸ Background, with a Reset button.
- **Camera** (View ▸ Camera):
  - Perspective or orthographic.
  - Focal length 10–300 mm (35 mm equivalent), with presets.
  - Clipping planes are automatic, or set by hand.
  - Stage cameras, chosen in the toolbar, keep their own lens.
- **Purposes, backface culling, tone mapping, exposure**: View ▸ Purposes and View ▸ Shading.
- **Subdivision** follows Omniverse's convention:
  - **Global level** (toolbar): 0 by default, like usdview and Omniverse. `Auto` picks the highest level up to 2 that keeps the stage under 3 million triangles.
  - **Per-mesh override**: the custom attributes `refinementEnableOverride` / `refinementLevel`, edited in the property panel's Refinement section. They travel with the file.

## Statistics

The box at the top right of the viewport shows the visible meshes' **vertices, faces and edges as authored in USD**:
- each instance is counted;
- holes are left out;
- the counts don't depend on refinement or triangulation.

It also shows how many distinct **materials** are bound to those meshes and how many **textures** the materials use.

Two more rows report drawing speed:
- **FPS** counts frames drawn in the last second. The view only redraws when something changes, so a still view reads `idle`.
- **Frame** is the CPU time of the last draw.
