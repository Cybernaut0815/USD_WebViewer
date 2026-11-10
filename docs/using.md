# Using the viewer

[← README](../README.md)

Open files with File ▸ Open… or File ▸ Folder…, or by dropping them on the viewer, or with `?src=<url>`. The **Examples** menu loads sample stages from [github.com/usd-wg/assets](https://github.com/usd-wg/assets) over the network. Press **?** or **F1** for the Help window, which lists every key and mouse gesture. Keys work while the viewport or the hierarchy has focus, but not while you are typing in a field.

## Navigation and selection

| Input | Action |
|---|---|
| Left drag / right drag / wheel | Orbit / pan / zoom towards the cursor |
| `N`, then `W` `A` `S` `D` | Navigate mode, game-style: hold a mouse button to look around, `W` `A` `S` `D` fly forward, left, back, right. The wheel sets the speed (shown at the top left), `Shift` flies faster and `Alt` slower. `N` again (or `Q`) leaves it |
| `F` | Frame the selection, or everything |
| Click | Select one prim; clicking empty space clears the selection |
| Shift+click | Add a prim and make it the **active** one. On a prim that is already selected, it only makes it active |
| Ctrl+click | Remove a prim from the selection |
| Shift+Ctrl+click | Add the prim's parent. Each further Shift+Ctrl+click adds the next level up |
| Shift+Alt+click | Add the prim's parent together with everything below it. Each further Shift+Alt+click does the same one level higher |
| Alt+click (hierarchy) | Add every row between the last clicked row and this one |
| Shift+drag **up** | Add everything the rectangle touches |
| Shift+drag **down** | Add only what lies fully inside the rectangle |
| Ctrl+drag | Remove from the selection, in the same two ways |

- The **active** prim has the brighter highlight. The property panel shows it, and the transform gizmo sits on it.
- With several prims selected, a dropdown above the property panel picks which one is shown.
- The rectangle tests screen-space bounding boxes, not exact outlines.
- Shift+Alt takes at most 10,000 prims of a subtree; above that it warns in the messages.
- An Alt+click range runs over the rows as they are shown, or over the search results when a search is shown. Collapsed rows are not included.

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
  - `Q` is Select; `W` / `E` / `R` are Move / Rotate / Scale. The buttons at the top left of the view switch tools too.
  - `N` is Navigate: the camera flies (see above), and Move / Rotate / Scale are off until you leave it. A click without a drag still selects, and a right click still opens the prim menu. `Ctrl` is not a speed key, because `Ctrl+W` closes the browser tab.
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
- **Numeric arrays** (points, indices, uv sets, ...) are not read when a prim is selected, so selecting a huge mesh costs nothing: click **load…** in their box, or **Load all** next to Frame, to see the first values. **View ▸ Details ▸ Load array values automatically** fills them on every selection instead (remembered per browser). Copying, by click or right click, always gets the whole array, loaded or not. The world bounds in the World transform section are computed when that section is open.

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
  - **Global level** (toolbar): 0 by default, like usdview and Omniverse. A level of 1–3 refines every mesh whose scheme is catmullClark or loop. That includes meshes that never set a scheme, because USD's fallback is catmullClark; most production polygon cages are like that.
  - **Auto** only refines meshes whose file explicitly sets `subdivisionScheme` to catmullClark or loop. Of those, it uses the highest level up to 2 whose output stays within the **Auto budget**. Everything else stays at 0, so a stage like Kitchen_set, which sets no scheme, is left as authored.
  - **Auto budget** (View ▸ Subdivision): defaults to this machine's value, taken from its memory and CPU threads, between about 1.5 and 6 million triangles. It can be set by hand from 0.5 to 8 million and is remembered in the browser. The upper limit protects the core's 4 GB WebAssembly heap. One mesh never refines past two thirds of the budget.
  - **Per-mesh override**: the custom attributes `refinementEnableOverride` / `refinementLevel`, edited in the property panel's Refinement section. They travel with the file and win over the global level and Auto.

## Sections

**Section**, after the tool buttons at the top left of the view, cuts the view open with clipping planes and boxes. It changes only what is drawn: the stage, its files and the shadows stay whole, and picking goes through to what is behind a cut.

- **Adding.** Each new plane or box is selected at once (see below).
  - **Plane X / Y / Z** through the stage's centre keeps its negative side: below the horizontal one, which the menu marks.
  - **Plane facing the view** goes through the orbit target and keeps what lies beyond it.
  - **Box around the selection** (around the stage when nothing is selected) shows only what is inside it.
  - At most 8 planes and 8 boxes. A point shows when every plane keeps it, no "cut out" box holds it, and, if there are "show inside" boxes, one of them holds it.
- **Handles.** Every plane and box shows its outline and dots in the view, so it can be selected and moved at any time. **Hide handles** in the menu hides them (the cut stays) and **Show handles** brings them back; **Sections off** hides them too.
- **Selecting.** Click a dot or an outline (in the Select tool, or a Move, Rotate or Scale tool, which switches to Select). **Shift+click** or **Ctrl+click** adds or removes it, so several planes and boxes can be selected and moved together. A click on anything else selects none of them.
  - A box's dot chooses that handle of the box; its outline chooses the whole box. A plane has one dot, in the middle of its outline.
  - **Del** deletes the selected planes and boxes. **Esc** clears the box handles chosen; pressed again, it selects none.
- **Moving.** The arrows sit in the middle of what is chosen and move it all together. A plane alone moves along its normal; with others it moves by the part of the move along its normal.
  - Box corners move only across, in plan; the top and bottom move only up and down.
  - A move that would make a footprint cross itself, or bring a top below its bottom, stops at the last shape that worked.
- **Each entry in the menu.** Edit (select it alone) or Rotate it, Flip a plane, switch a box between "show inside" and "cut out", or Remove it. **Sections off** shows everything but keeps the entries; **Clear** removes them all.
- **Planes.** The outline spans the stage, and its arrow points to the side that stays. Rotate tilts a plane about its dot.
- **Boxes** stand upright: a footprint of four corners between a bottom and a top height. The sides stay vertical, and the top and bottom stay level.
  - A box has a dot at the top and bottom of every corner, and one on the top and on the bottom face. A corner's two dots are one vertical edge: either one chooses that corner.
  - Rotate turns the footprint about the vertical through its middle.
- Navigate, Move, Rotate and Scale (`N` `W` `E` `R`) select none, and so does **Select none** in the menu. In Navigate a click does not select them.

## Statistics

The box at the top right of the viewport shows the visible meshes' **vertices, faces and edges as authored in USD**:
- each instance is counted;
- holes are left out;
- the counts don't depend on refinement or triangulation.

It also shows how many distinct **materials** are bound to those meshes and how many **textures** the materials use.

Two more rows report drawing speed:
- **FPS** counts frames drawn in the last second. The view only redraws when something changes, so a still view reads `idle`.
- **Frame** is the CPU time of the last draw.
