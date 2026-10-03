// Toolbar: file opening, framing, camera, refinement, purposes, display settings, messages.
import { collectDrop, download, fromInput } from './files.ts';
import { h } from './props.ts';
import { type PanelState, SKIES, type ToolName, type UsdViewerElement } from './viewer.ts';
import type { DisplayMode } from './scene.ts';
import type { ToneMapping, Viewport } from './viewport.ts';

export function toolbar(viewer: UsdViewerElement, viewport: Viewport): HTMLElement {
  const session = viewer.session;
  const button = (label: string, title: string, action: () => void) => {
    const b = h('button', { title }, label);
    b.addEventListener('click', action);
    return b;
  };
  const select = (title: string, options: [string, string][], action: (value: string) => void, initial = '') => {
    const s = h('select', { title }) as HTMLSelectElement;
    for (const [value, label] of options) s.append(h('option', { value, selected: value === initial }, label));
    s.addEventListener('change', () => action(s.value));
    return s;
  };

  const file = h('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  const folder = h('input', { type: 'file', webkitdirectory: true, hidden: true }) as HTMLInputElement;
  for (const input of [file, folder]) {
    input.addEventListener('change', () => {
      if (input.files?.length) viewer.open(fromInput(input.files)).catch(() => {});
      input.value = '';
    });
  }

  const cameras = h('select', { title: 'Camera' }) as HTMLSelectElement;
  cameras.addEventListener('change', () => (viewer.camera = cameras.value || null));
  const refresh = () => {
    const current = cameras.value;
    cameras.replaceChildren(
      h('option', { value: '' }, 'Free camera'),
      ...viewport.sync.cameras().map((c) => h('option', { value: c.path, selected: c.path === current }, c.path)),
    );
  };
  session.addEventListener('delta', (e) => {
    const delta = (e as CustomEvent).detail;
    if (delta.cameras || delta.removed) refresh();
  });
  session.addEventListener('stageclose', refresh);

  const refine = select(
    'Global subdivision refinement level; meshes with their own override keep it',
    [['-1', 'Refine: auto'], ['0', 'Refine 0'], ['1', 'Refine 1'], ['2', 'Refine 2'], ['3', 'Refine 3']],
    (v) => session.usd.setComplexity(Number(v)),
    String(session.refineLevel),
  );
  session.addEventListener('refinechange', (e) => {
    refine.value = String((e as CustomEvent).detail.level);
    refine.options[0].textContent = session.refineLevel < 0 ? `Refine: auto (${session.effectiveRefineLevel})` : 'Refine: auto';
  });
  const display = select(
    'Display mode',
    [
      ['shaded', 'Shaded'],
      ['shaded-wire', 'Shaded + wire'],
      ['shaded-selwire', 'Shaded + selection wire'],
      ['plain', 'Plain'],
      ['plain-wire', 'Plain + wire'],
      ['plain-selwire', 'Plain + selection wire'],
      ['wire', 'Wireframe'],
    ],
    (v) => (viewer.displayMode = v as DisplayMode),
  );
  viewer.addEventListener('displaymodechange', () => (display.value = viewer.displayMode));
  const sky = select(
    'Sky: an HDRI lighting the stage and filling the background, in place of the stage\'s dome light',
    [['', 'No sky'], ...Object.entries(SKIES)],
    (v) => (viewer.sky = v || null),
  );
  viewer.addEventListener('skychange', () => (sky.value = viewer.sky ?? ''));
  const panelBoxes = (['hierarchy', 'details', 'timeline'] as (keyof PanelState)[]).map((panel) => {
    const box = h('input', { type: 'checkbox', checked: viewer.panels[panel] }) as HTMLInputElement;
    box.addEventListener('change', () => (viewer.panels = { [panel]: box.checked }));
    viewer.addEventListener('panelschange', () => (box.checked = viewer.panels[panel]));
    return h('label', {}, box, ` ${panel[0].toUpperCase()}${panel.slice(1)}`);
  });
  const help = button('?', 'Keys and mouse (F1)', () => viewer.showHelp());

  const purposeBoxes = ['default', 'proxy', 'render', 'guide'].map((purpose) => {
    const box = h('input', { type: 'checkbox', checked: purpose === 'default' || purpose === 'proxy', value: purpose }) as HTMLInputElement;
    box.addEventListener('change', () => (viewer.purposes = purposeBoxes.filter((b) => b.checked).map((b) => b.value)));
    return box;
  });
  const cull = h('input', { type: 'checkbox' }) as HTMLInputElement;
  cull.addEventListener('change', () => viewport.sync.setCullBackfaces(cull.checked));
  const exposure = h('input', { type: 'range', min: '-6', max: '6', step: '0.25', value: '0', title: 'Exposure (EV)' }) as HTMLInputElement;
  exposure.addEventListener('input', () => (viewer.exposure = Number(exposure.value)));

  const messagesButton = h('button', { title: 'Messages' }, '0 messages') as HTMLButtonElement;
  const messages = h('dialog', { className: 'messages' }) as HTMLDialogElement;
  messagesButton.addEventListener('click', () => messages.showModal());
  messages.addEventListener('click', (event) => event.target === messages && messages.close());
  for (const type of ['log', 'error'] as const) {
    session.addEventListener(type, (e) => {
      const { level, message } = (e as CustomEvent).detail;
      messages.append(h('p', { className: level }, message));
      messagesButton.textContent = `${session.log.length} messages`;
      messagesButton.classList.toggle('alert', session.log.some((entry) => entry.level === 'error'));
    });
  }
  const badge = h('span', { className: 'backend' });
  // The toolbar is built inside the element's constructor, before `ready` exists.
  queueMicrotask(() => viewer.ready.then(() => (badge.textContent = viewer.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'), () => {}));

  // Editing: tool, edit target, saving.
  const tool = select(
    'Tool (Q W E R)',
    [['select', 'Select'], ['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']],
    (v) => (viewer.tool = v as ToolName),
  );
  viewer.addEventListener('toolchange', () => (tool.value = viewer.tool));
  const save = button('Save', 'Write layers with unsaved edits back into the opened folder, or download them', () => viewer.save().catch(() => {})) as HTMLButtonElement;
  const target = h('select', { title: 'Edit target: the layer that receives edits' }) as HTMLSelectElement;
  target.addEventListener('change', () => session.usd.setEditTarget(target.value).catch(() => {}));
  const refreshLayers = async () => {
    if (!session.stage) {
      target.replaceChildren();
      return;
    }
    const layers = (await session.usd.layers()).filter((l) => l.inStack);
    target.replaceChildren(
      ...layers.map((l) => h('option', { value: l.identifier, selected: l.editTarget }, `${l.session ? 'session (not saved)' : l.displayName}${l.dirty ? ' *' : ''}`)),
    );
  };
  const refreshDirty = () => {
    save.disabled = session.dirty.size === 0;
    save.textContent = session.dirty.size ? 'Save *' : 'Save';
    refreshLayers();
  };
  session.addEventListener('dirtychange', refreshDirty);
  session.addEventListener('stageopen', refreshDirty);
  session.addEventListener('stageclose', refreshDirty);
  refreshDirty();
  // Menus drop down below their button with their groups side by side; one is open at a time.
  const menus: HTMLDetailsElement[] = [];
  const menu = (name: string, ...groups: [string, ...Node[]][]) => {
    const details = h(
      'details',
      { className: 'menu' },
      h('summary', {}, name),
      h('div', { className: 'dropdown' }, ...groups.map(([title, ...items]) => h('section', {}, h('h5', {}, title), ...items))),
    ) as HTMLDetailsElement;
    details.addEventListener('toggle', () => details.open && menus.forEach((other) => other !== details && (other.open = false)));
    menus.push(details);
    return details;
  };
  const closeMenus = () => menus.forEach((m) => (m.open = false));
  document.addEventListener('pointerdown', (e) => menus.forEach((m) => m.open && !e.composedPath().includes(m) && (m.open = false)), true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());
  /** A menu command: runs and closes its menu. */
  const item = (label: string, title: string, action: () => void) =>
    button(label, title, () => {
      closeMenus();
      action();
    });

  // View ▸ Camera: the free camera's lens; stage cameras keep their own.
  const projection = select('Projection', [['perspective', 'Perspective'], ['orthographic', 'Orthographic']], (v) => (viewer.cameraSettings = { projection: v as 'perspective' }));
  const focal = h('input', { type: 'range', min: '10', max: '300', step: '1', title: 'Focal length (mm, 35 mm equivalent)' }) as HTMLInputElement;
  const focalNumber = h('input', { type: 'number', min: '10', max: '300', step: '1', className: 'short' }) as HTMLInputElement;
  const fov = h('span', { className: 'dim' });
  for (const input of [focal, focalNumber]) input.addEventListener('input', () => input.value && (viewer.cameraSettings = { focalLength: Number(input.value) }));
  const presets = h('div', { className: 'presets' }, ...[24, 35, 50, 85, 135].map((mm) => button(`${mm}`, `${mm} mm`, () => (viewer.cameraSettings = { focalLength: mm }))));
  const autoClip = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const near = h('input', { type: 'number', min: '0.001', max: '1000', step: 'any', className: 'short', title: 'Near clipping plane' }) as HTMLInputElement;
  const far = h('input', { type: 'number', min: '0.1', max: '1000000', step: 'any', className: 'short', title: 'Far clipping plane' }) as HTMLInputElement;
  const clipNumber = (v: number) => String(+v.toPrecision(4));
  autoClip.addEventListener('change', () => {
    const { near: n, far: f } = viewer.cameraSettings; // switching auto off starts from the fitted planes
    viewer.cameraSettings = autoClip.checked ? { autoClip: true } : { autoClip: false, near: Number(clipNumber(n)), far: Number(clipNumber(f)) };
  });
  near.addEventListener('change', () => (viewer.cameraSettings = { near: Number(near.value) }));
  far.addEventListener('change', () => (viewer.cameraSettings = { far: Number(far.value) }));
  const stageNote = h('span', { className: 'dim', hidden: true }, 'Looking through a stage camera');
  const syncCamera = () => {
    const c = viewer.cameraSettings;
    const stage = viewer.camera !== null;
    projection.value = c.projection;
    focal.value = focalNumber.value = String(Math.round(c.focalLength));
    fov.textContent = `${((2 * Math.atan(12 / c.focalLength) * 180) / Math.PI).toFixed(1)}° vertical`;
    autoClip.checked = c.autoClip;
    if (!c.autoClip) {
      near.value = clipNumber(c.near);
      far.value = clipNumber(c.far);
    }
    for (const control of [projection, autoClip]) control.disabled = stage;
    for (const control of [focal, focalNumber, ...presets.children]) (control as HTMLInputElement).disabled = stage || c.projection === 'orthographic';
    for (const control of [near, far]) control.disabled = stage || c.autoClip;
    stageNote.hidden = !stage;
  };
  viewer.addEventListener('camerachange', syncCamera);
  cameras.addEventListener('change', syncCamera);
  syncCamera();

  const fileMenu = menu(
    'File',
    [
      'Open',
      item('Open…', 'Open USD files', () => file.click()),
      item('Folder…', 'Open a folder (with write access where the browser allows it)', async () => {
        // The File System Access API gives write-back; the input element is the fallback.
        const picker = (window as any).showDirectoryPicker as ((options: object) => Promise<FileSystemDirectoryHandle>) | undefined;
        if (!picker) return folder.click();
        const handle = await picker({ mode: 'readwrite' }).catch(() => null);
        if (handle) viewer.open(handle).catch(() => {});
      }),
      item('URL…', 'Open a URL', () => {
        const url = prompt('USD file URL');
        if (url) viewer.open(url).catch(() => {});
      }),
    ],
    [
      'Layers',
      h('label', {}, 'Edit target ', target),
      item('Download flattened', 'The whole stage composed into one usda file', async () => {
        const bytes = await session.usd.exportLayer('', 'flat');
        if (bytes) download(`${(session.stage?.url.split('/').pop() ?? 'stage').replace(/\.[^.]+$/, '')}.flat.usda`, bytes);
      }),
      item('Reload from disk', 'Re-read every layer, discarding unsaved edits', () => {
        if (!session.dirty.size || confirm('Discard unsaved edits and reload?')) session.usd.reload().catch(() => {});
      }),
    ],
  );
  const editMenu = menu(
    'Edit',
    ['History', item('Undo', 'Ctrl+Z', () => viewer.undo()), item('Redo', 'Ctrl+Shift+Z', () => viewer.redo())],
    [
      'Refinement',
      item('Clear all overrides', 'Remove refinementEnableOverride / refinementLevel from every prim', () =>
        session.usd.clearRefinementOverrides().catch(() => {}),
      ),
    ],
  );
  const viewMenu = menu(
    'View',
    ['Panels', ...panelBoxes, item('Frame', 'Frame selection or everything (F)', () => viewer.frame(session.selection))],
    ['Purposes', ...purposeBoxes.map((box) => h('label', {}, box, ` ${box.value}`))],
    [
      'Shading',
      h('label', { title: 'Hide the back of single-sided meshes' }, cull, ' Cull backfaces'),
      h('label', {}, 'Tone mapping ', select('Tone mapping', [['neutral', 'Neutral'], ['aces', 'ACES'], ['agx', 'AgX'], ['none', 'None']], (v) => (viewer.toneMapping = v as ToneMapping))),
      h('label', {}, 'Exposure ', exposure),
    ],
    [
      'Camera',
      stageNote,
      h('label', {}, 'Projection ', projection),
      h('label', {}, 'Focal length ', focalNumber, ' mm'),
      focal,
      fov,
      presets,
      h('label', {}, autoClip, ' Auto clipping'),
      h('label', {}, 'Near ', near),
      h('label', {}, 'Far ', far),
    ],
  );

  const element = h(
    'header',
    { className: 'toolbar' },
    fileMenu,
    editMenu,
    viewMenu,
    save,
    tool,
    cameras,
    refine,
    display,
    sky,
    h('slot', { name: 'toolbar' }),
    h('span', { className: 'grow' }),
    help,
    messagesButton,
    badge,
    file,
    folder,
    messages,
  );
  // Dropping files anywhere on the viewer opens them.
  viewer.addEventListener('dragover', (event) => event.preventDefault());
  viewer.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (event.dataTransfer) viewer.open(await collectDrop(event.dataTransfer)).catch(() => {});
  });
  return element;
}
