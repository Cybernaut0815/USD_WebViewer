// Toolbar: file opening, framing, camera, refinement, purposes, display settings, messages.
import { collectDrop, download, fromInput } from './files.ts';
import { h } from './props.ts';
import type { ToolName, UsdViewerElement } from './viewer.ts';
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
    [['shaded', 'Shaded'], ['shaded-wire', 'Shaded + wire'], ['plain-wire', 'Plain + wire'], ['wire', 'Wireframe']],
    (v) => (viewer.displayMode = v as DisplayMode),
  );
  viewer.addEventListener('displaymodechange', () => (display.value = viewer.displayMode));

  const purposeBoxes = ['default', 'proxy', 'render', 'guide'].map((purpose) => {
    const box = h('input', { type: 'checkbox', checked: purpose === 'default' || purpose === 'proxy', value: purpose }) as HTMLInputElement;
    box.addEventListener('change', () => viewport.sync.setPurposes(purposeBoxes.filter((b) => b.checked).map((b) => b.value)));
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
  const menu = (name: string) => h('details', { className: 'menu' }, h('summary', {}, name));
  const fileMenu = menu('File');
  const editMenu = menu('Edit');
  const menuItem = (owner: HTMLElement, label: string, title: string, action: () => void) => {
    const b = button(label, title, () => {
      owner.removeAttribute('open');
      action();
    });
    return h('label', {}, b);
  };
  const item = (label: string, title: string, action: () => void) => menuItem(fileMenu, label, title, action);
  const viewMenu = menu('View');
  viewMenu.append(
    menuItem(viewMenu, 'Frame', 'Frame selection or everything (F)', () => viewer.frame(session.selection)),
    ...purposeBoxes.map((box) => h('label', {}, box, ` ${box.value} purpose`)),
    h('label', { title: 'Hide the back of single-sided meshes' }, cull, ' Cull backfaces'),
    h('label', {}, 'Tone mapping ', select('Tone mapping', [['neutral', 'Neutral'], ['aces', 'ACES'], ['agx', 'AgX'], ['none', 'None']], (v) => (viewer.toneMapping = v as ToneMapping))),
    h('label', {}, 'Exposure ', exposure),
  );
  editMenu.append(
    menuItem(editMenu, 'Undo', 'Ctrl+Z', () => viewer.undo()),
    menuItem(editMenu, 'Redo', 'Ctrl+Shift+Z', () => viewer.redo()),
    menuItem(editMenu, 'Clear all refinement overrides', 'Remove refinementEnableOverride / refinementLevel from every prim', () =>
      session.usd.clearRefinementOverrides().catch(() => {}),
    ),
  );
  fileMenu.append(
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
    h('label', {}, 'Edit target ', target),
    item('Download flattened', 'The whole stage composed into one usda file', async () => {
      const bytes = await session.usd.exportLayer('', 'flat');
      if (bytes) download(`${(session.stage?.url.split('/').pop() ?? 'stage').replace(/\.[^.]+$/, '')}.flat.usda`, bytes);
    }),
    item('Reload from disk', 'Re-read every layer, discarding unsaved edits', () => {
      if (!session.dirty.size || confirm('Discard unsaved edits and reload?')) session.usd.reload().catch(() => {});
    }),
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
    h('slot', { name: 'toolbar' }),
    h('span', { className: 'grow' }),
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
