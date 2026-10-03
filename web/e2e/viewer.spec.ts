import { expect, type Page, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { UsdViewerElement } from '../src/viewer.ts';

const MOCK = '/?core=mock-core/&forceWebGL=1&src=mock.usda';

/** Opens the app and waits until the stage is drawn. */
async function open(page: Page, url: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  // Clipboard writes land in window.copied: headless pages have no reliable clipboard to read back.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void ((window as any).copied = text) } });
  });
  await page.goto(url);
  await page.evaluate(async () => {
    const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
    await viewer.ready;
    if (!viewer.hasAttribute('src')) return; // nothing to wait for
    if (!viewer.stage) await new Promise((resolve) => viewer.addEventListener('stageopen', resolve, { once: true }));
    await viewer.idle();
  });
  return errors;
}

/** Drags the move gizmo's X handle of a prim by 60 px along the screen direction of world +X. */
async function dragAlongX(page: Page, path: string) {
  const [center, alongX] = await page.evaluate((path) => {
    const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
    const object = viewer.three.objectsFor(path)[0];
    const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
    const world = object.getWorldPosition(object.position.clone());
    const screen = (v: typeof world) => {
      const p = v.clone().project(viewer.three.camera);
      return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height];
    };
    return [screen(world), screen(world.clone().setX(world.x + 1))];
  }, path);
  const length = Math.hypot(alongX[0] - center[0], alongX[1] - center[1]);
  const dir = [(alongX[0] - center[0]) / length, (alongX[1] - center[1]) / length];
  const at = (d: number) => [center[0] + dir[0] * d, center[1] + dir[1] * d] as const;
  await page.mouse.move(...at(45));
  await page.mouse.down();
  for (let d = 50; d <= 105; d += 5) await page.mouse.move(...at(d));
  await page.mouse.up();
}

test.describe('mock core', () => {
  test('renders the stage', async ({ page }) => {
    const errors = await open(page, MOCK);
    expect(errors).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-stage.png');
  });

  test('tree click selects and fills the properties', async ({ page }) => {
    await open(page, MOCK);
    const selection = page.evaluate(
      () =>
        new Promise((resolve) =>
          document.querySelector('usd-viewer')!.addEventListener('selectionchange', (e) => resolve((e as CustomEvent).detail), { once: true }),
        ),
    );
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    expect(await selection).toEqual({ paths: ['/World/Cube'], source: 'hierarchy', active: '/World/Cube' });
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Cube');
  });

  test('ctrl-click builds a multi-selection with one active prim shown in the panel', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click({ modifiers: ['Control'] });
    await expect(page.locator('usd-viewer .row.selected')).toHaveCount(2);
    await expect(page.locator('usd-viewer .row.active')).toHaveText(/Light/);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Light');
    // Ctrl-click on a selected prim only makes it active; on the active one it deselects.
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click({ modifiers: ['Control'] });
    await expect(page.locator('usd-viewer .row.active')).toHaveText(/Cube/);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Cube');
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click({ modifiers: ['Control'] });
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection)).toEqual(['/World/Light']);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Light');
  });

  test('folded property sections stay folded when another prim is selected', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    const attributes = page.locator('usd-viewer .props details', { has: page.locator('summary', { hasText: 'Attributes' }) });
    await expect(attributes).toHaveAttribute('open', '');
    await attributes.locator('summary').click();
    await expect(attributes).not.toHaveAttribute('open', '');
    await page.locator('usd-viewer .row .name', { hasText: 'World' }).click();
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('World');
    await expect(page.locator('usd-viewer .props details', { has: page.locator('summary', { hasText: 'Attributes' }) })).not.toHaveAttribute('open', '');
  });

  test('canvas click selects and reveals the tree row', async ({ page }) => {
    await open(page, MOCK);
    const box = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('usd-viewer .row.selected')).toHaveCount(1);
    const selected = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection);
    expect(selected.length).toBe(1);
  });

  test('a parent with 50,000 children keeps the DOM small', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row', { hasText: 'Big' }).locator('.twisty').click();
    await expect(page.locator('usd-viewer .row', { hasText: 'Child_0' }).first()).toBeVisible();
    expect(await page.locator('usd-viewer .row').count()).toBeLessThanOrEqual(100);
  });

  test('host panels slot into the layout and share the session', async ({ page }) => {
    await open(page, MOCK);
    const result = await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const button = document.createElement('button');
      button.slot = 'toolbar';
      button.textContent = 'Mine';
      const panel = document.createElement('div');
      panel.slot = 'right';
      panel.textContent = 'Host panel';
      viewer.append(button, panel);
      return {
        slots: [button.assignedSlot?.name, panel.assignedSlot?.name],
        sameSession: viewer.session.usd === viewer.usd,
        visible: panel.getBoundingClientRect().width > 0,
      };
    });
    expect(result).toEqual({ slots: ['toolbar', 'right'], sameSession: true, visible: true });
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).session.selection)).toEqual(['/World/Cube']);
  });

  test('nested metadata and attribute metadata show in the properties', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'World' }).click();
    const metadata = page.locator('usd-viewer .props details', { hasText: 'Metadata' });
    await expect(metadata).toContainText('customData');
    await expect(metadata.locator('table table table')).toContainText('depth');
    await page.locator('usd-viewer .props .twisty').first().click();
    await expect(page.locator('usd-viewer .props tr.meta')).toContainText('edge length');
  });

  test('context menus copy attribute values and prim USD', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    const copied = () => page.evaluate(() => (window as any).copied); // written after an async value fetch
    const value = page.locator('usd-viewer .props tr', { hasText: 'faceVertexCounts' }).locator('.value');
    await value.click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Copy type name = value' }).click();
    await expect.poll(copied).toBe('int[] faceVertexCounts = [4, 4, 4]');
    await value.click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Copy value' }).click();
    await expect.poll(copied).toBe('[4, 4, 4]');
    await page.locator('usd-viewer .row', { hasText: 'Cube' }).click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Copy composed USD' }).click();
    await expect.poll(copied).toContain('def Xform "Cube"');
    await page.locator('usd-viewer .row', { hasText: 'Cube' }).click({ button: 'right' });
    await page.keyboard.press('Escape');
    await expect(page.locator('usd-viewer .popup')).toHaveCount(0);
  });

  test('locked prims cannot be picked and drop out of the selection', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    // Locking an ancestor covers the subtree: the selected cube drops out and nothing is pickable.
    const world = page.locator('usd-viewer .row', { hasText: 'World' });
    await world.locator('.lock').click();
    await expect(world).toHaveClass(/dim/);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection)).toEqual([]);
    const box = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection)).toEqual([]);
    await world.locator('.lock').click();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('usd-viewer .row.selected')).toHaveCount(1);
  });

  test('display modes draw wireframes', async ({ page }) => {
    const errors = await open(page, MOCK);
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.displayMode = 'plain-wire';
      await viewer.idle();
    });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-plain-wire.png');
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.displayMode = 'wire';
      await viewer.idle();
      viewer.displayMode = 'shaded';
      await viewer.idle();
    });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-stage.png');
    expect(errors).toEqual([]);
  });

  test('transform edits move objects, mark the layer dirty, and undo', async ({ page }) => {
    await open(page, MOCK);
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = viewer.three.objectsFor('/World/Cube')[0];
      const before = cube.matrix.elements[12];
      await viewer.usd.setXform('/World/Cube', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]);
      await viewer.idle();
      const moved = cube.matrix.elements[12];
      const dirty = viewer.dirty;
      await viewer.undo();
      await viewer.idle();
      return { before, moved, dirty, after: cube.matrix.elements[12] };
    });
    expect(result.moved).toBeCloseTo(5, 3);
    expect(result.after).toBeCloseTo(result.before, 3);
    expect(result.dirty).toBe(true);
  });

  test('the move gizmo drags the selected prim and keeps one undo step', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).tool = 'translate'));
    await dragAlongX(page, '/World/Cube');
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.idle();
      const cube = viewer.three.objectsFor('/World/Cube')[0];
      const moved = cube.matrix.elements[12];
      const canUndo = viewer.session.commands.canUndo;
      await viewer.undo();
      await viewer.idle();
      return { moved, canUndo, after: cube.matrix.elements[12], selection: viewer.selection };
    });
    expect(result.moved).toBeGreaterThan(0.2);
    expect(result.canUndo).toBe(true);
    expect(result.after).toBeCloseTo(0, 3);
    expect(result.selection).toEqual(['/World/Cube']);
  });

  test('save writes dirty layers into the picked folder, which is then watched for changes', async ({ page }) => {
    await page.addInitScript(() => {
      // A fake File System Access directory with one file, controllable from the test.
      const state = { text: '#usda 1.0\n', modified: 1, written: '' };
      (window as any).fake = state;
      const file = {
        kind: 'file',
        name: 'mock.usda',
        getFile: async () => new File([state.text], 'mock.usda', { lastModified: state.modified }),
        createWritable: async () => ({ write: async (chunk: BufferSource) => void (state.written = new TextDecoder().decode(chunk)), close: async () => {} }),
      };
      (window as any).showDirectoryPicker = async () => ({ kind: 'directory', name: 'scene', entries: async function* () { yield ['mock.usda', file]; } });
    });
    await open(page, '/?core=mock-core/&forceWebGL=1');
    const saved = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.open(await (window as any).showDirectoryPicker());
      await viewer.idle();
      await viewer.usd.setXform('/World/Cube', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]);
      const dirtyBefore = viewer.dirty;
      const saved = await viewer.save();
      return { url: viewer.stage!.url, dirtyBefore, saved, dirtyAfter: viewer.dirty, written: (window as any).fake.written };
    });
    expect(saved).toEqual({ url: '/drop/1/scene/mock.usda', dirtyBefore: true, saved: ['/drop/1/scene/mock.usda'], dirtyAfter: false, written: '#usda 1.0\n# cube offset 5\n' });
    // Another program changes the file: the layer is re-read within a few seconds.
    const reloaded = page.evaluate(() => new Promise((resolve) => document.querySelector('usd-viewer')!.addEventListener('diskchange', (e) => resolve((e as CustomEvent).detail), { once: true })));
    await page.evaluate(() => ((window as any).fake.modified = 2));
    expect(await reloaded).toEqual({ identifiers: ['/drop/1/scene/mock.usda'] });
    // With unsaved edits it only warns.
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.usd.setXform('/World/Cube', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1]);
      (window as any).fake.modified = 3;
    });
    await expect.poll(() => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).session.log.some((l) => l.message.includes('Changed on disk')))).toBe(true);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).dirty)).toBe(true);
  });

  test('playback keeps one flush in flight and reuses GPU buffers', async ({ page }) => {
    await open(page, MOCK);
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = viewer.three.objectsFor('/World/Cube')[0];
      const before = cube.matrix.elements[12];
      viewer.time = 13;
      await viewer.idle();
      return { before, after: cube.matrix.elements[12], same: viewer.three.objectsFor('/World/Cube')[0] === cube };
    });
    expect(result.same).toBe(true);
    expect(result.after).not.toBeCloseTo(result.before, 3);
  });
});

/* ---------- the real wasm core, against the sample stage ---------- */

const SHOWCASE = '/?forceWebGL=1&src=samples/showcase.usda';

test.describe('wasm core', () => {
  test.skip(!existsSync(new URL('../public/core/usdcore.wasm', import.meta.url)), 'usdcore.wasm has not been built');

  test('renders the sample stage without errors', async ({ page }) => {
    const errors = await open(page, SHOWCASE);
    const logged = await page.evaluate(() =>
      [...document.querySelector('usd-viewer')!.shadowRoot!.querySelectorAll('.messages p')].map((p) => p.textContent),
    );
    expect(errors).toEqual([]);
    expect(logged).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('showcase.png');
  });

  test('MaterialX networks render through three.js', async ({ page }) => {
    const errors = await open(page, '/?forceWebGL=1&src=samples/materialx.usda');
    expect(errors).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('materialx.png');
  });

  test('hierarchy and properties show the selected prim', async ({ page }) => {
    await open(page, SHOWCASE);
    await page.locator('usd-viewer .row', { hasText: 'Shapes' }).locator('.twisty').click();
    await page.locator('usd-viewer .row .name', { hasText: 'Sphere' }).click();
    await expect(page.locator('usd-viewer .props .head .type')).toHaveText('Sphere');
    await expect(page.locator('usd-viewer .props')).toContainText('/World/Looks/Gold');
    await expect(page.locator('usd-viewer .props')).toContainText('radius');
  });

  test('the inspector lists primvars, metadata, arcs and refinement of a mesh', async ({ page }) => {
    await open(page, SHOWCASE);
    await page.locator('usd-viewer .row .name', { hasText: 'SubdivCube' }).click();
    const props = page.locator('usd-viewer .props');
    const section = (title: string) => props.locator('details', { has: page.locator('summary', { hasText: title }) });
    await expect(props).toContainText('creased top edge loop');
    await expect(section('Primvars')).toContainText('texCoord2f[] faceVarying');
    await expect(section('Metadata')).toContainText('MaterialBindingAPI');
    await expect(section('Composition')).toContainText('root');
    const refinement = section('Refinement');
    await expect(refinement).toContainText('auto');
    await refinement.locator('input[type=checkbox]').check();
    // Null-safe: the mesh object is swapped while its index count changes.
    const count = (n: number) =>
      page.waitForFunction((n) => (document.querySelector('usd-viewer') as any).three.objectsFor('/World/SubdivCube')[0]?.geometry?.index?.count === n, n);
    await count(36); // override on at level 0; the panel has been rebuilt by now
    await refinement.locator('input[type=number]').fill('3');
    await refinement.locator('input[type=number]').dispatchEvent('change');
    await count(2304);
    const authored = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).usd.exportPrim('/World/SubdivCube', 'authored'));
    expect(authored).toContain('custom int refinementLevel = 3');
  });

  test('clicking geometry selects its prim', async ({ page }) => {
    await open(page, SHOWCASE);
    const paths = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      // Find the screen position of the sphere through the public three.js handle.
      const sphere = viewer.three.objectsFor('/World/Shapes/Sphere')[0];
      const point = sphere.getWorldPosition(sphere.position.clone()).project(viewer.three.camera);
      const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const hit = await viewer.pick(rect.left + ((point.x + 1) / 2) * rect.width, rect.top + ((1 - point.y) / 2) * rect.height);
      return hit?.path;
    });
    expect(paths).toBe('/World/Shapes/Sphere');
  });

  test('refining subdivides and a variant switch replaces geometry', async ({ page }) => {
    await open(page, SHOWCASE);
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const indexCount = () => (viewer.three.objectsFor('/World/SubdivCube')[0] as any).geometry.index.count;
      const cage = indexCount(); // level 0 by default
      await viewer.usd.setComplexity(-1);
      const auto = { level: viewer.session.effectiveRefineLevel, indices: indexCount() };
      await viewer.usd.setComplexity(2);
      const refined = indexCount();
      const before = (await viewer.usd.children('/World/Spinner'))[0].typeName;
      await viewer.usd.setVariant('/World/Spinner', 'shape', 'cone');
      const after = (await viewer.usd.children('/World/Spinner'))[0].typeName;
      return { auto, cage, refined, before, after, drawn: viewer.three.objectsFor('/World/Spinner').length };
    });
    expect(result.auto.level).toBeGreaterThan(0); // small stage: Auto refines it
    expect(result.auto.indices).toBe(36 * 4 ** result.auto.level);
    expect(result).toMatchObject({ cage: 36, refined: 576, before: 'Cube', after: 'Cone', drawn: 1 });
  });

  test('time changes move animated prims', async ({ page }) => {
    await open(page, SHOWCASE);
    const [start, later] = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const matrix = () => [...viewer.three.objectsFor('/World/Spinner')[0].matrix.elements];
      const first = matrix();
      viewer.time = 13; // a quarter turn
      await viewer.idle();
      return [first, matrix()];
    });
    expect(start[0]).toBeCloseTo(1, 3);
    expect(later[0]).toBeCloseTo(Math.cos((12 / 47) * 2 * Math.PI), 2);
  });

  test('the move gizmo authors xformOp:translate and Ctrl+Z restores it', async ({ page }) => {
    await open(page, SHOWCASE);
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.select('/World/Shapes/Sphere');
      viewer.tool = 'translate';
    });
    await dragAlongX(page, '/World/Shapes/Sphere');
    const translate = () => page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.idle();
      return viewer.usd.attribute('/World/Shapes/Sphere', 'xformOp:translate') as Promise<number[]>;
    });
    const moved = await translate();
    expect(moved[0]).toBeGreaterThan(-2.8);
    expect(moved[1]).toBeCloseTo(0.6, 4);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).dirty)).toBe(true);
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Control+z');
    expect(await translate()).toEqual([-3, 0.6, 0]);
  });

  test('the gizmo moves every selected prim around the active one', async ({ page }) => {
    await open(page, SHOWCASE);
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.select(['/World/Shapes/Sphere', '/World/Shapes/Cone']); // Cone is active
      viewer.tool = 'translate';
    });
    await dragAlongX(page, '/World/Shapes/Cone');
    const translates = () => page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.idle();
      return Promise.all(['/World/Shapes/Sphere', '/World/Shapes/Cone'].map((p) => viewer.usd.attribute(p, 'xformOp:translate') as Promise<number[]>));
    });
    const [sphere, cone] = await translates();
    expect(cone[0]).toBeGreaterThan(0.2);
    expect(sphere[0] - -3).toBeCloseTo(cone[0] - 0, 3); // the same offset
    expect(sphere[1]).toBeCloseTo(0.6, 4);
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Control+z');
    expect(await translates()).toEqual([[-3, 0.6, 0], [0, 0.6, 0]]);
  });

  test('save downloads the edited root layer when no folder was picked', async ({ page }) => {
    await open(page, SHOWCASE);
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).usd.setXform('/World/Shapes/Sphere', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]));
    const download = page.waitForEvent('download');
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).save());
    const file = await download;
    expect(file.suggestedFilename()).toBe('showcase.usda');
    const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
    expect(text).toContain('double3 xformOp:translate = (1, 2, 3)');
  });

  test('a host page drives the viewer through the API only', async ({ page }) => {
    await page.goto('/host.html?forceWebGL=1');
    await page.click('#open');
    await expect(page.locator('#log')).toContainText('opened, up axis Y');
    await page.click('#select');
    await expect(page.locator('#log')).toContainText('selected /World/Shapes/Sphere (api)');
    await page.click('#move');
    await expect(page.locator('#log')).toContainText('translate is now [0,3.2,0]');
  });
});

/* ---------- larger public assets, when they have been downloaded into public/test-assets ---------- */

test.describe('public assets', () => {
  const assets = new URL('../public/test-assets/', import.meta.url);
  test.skip(
    !existsSync(new URL('Kitchen_set/Kitchen_set.usd', assets)) || !existsSync(new URL('../public/core/usdcore.wasm', import.meta.url)),
    'needs the wasm core and public/test-assets (Kitchen_set from openusd.org)',
  );

  test('a picked folder opens from local files, references included', async ({ page }) => {
    const errors = await open(page, '/?forceWebGL=1&core=core/');
    await page.locator('usd-viewer input[webkitdirectory]').setInputFiles(fileURLToPath(new URL('Kitchen_set', assets)));
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      if (!viewer.stage) await new Promise((resolve) => viewer.addEventListener('stageopen', resolve, { once: true }));
      await viewer.idle();
      let meshes = 0;
      viewer.three.root.traverse((o) => ((o as any).isMesh ? meshes++ : 0));
      return { url: viewer.stage!.url, upAxis: viewer.stage!.upAxis, meshes };
    });
    expect(result.url).toMatch(/^\/drop\/\d+\/Kitchen_set\/Kitchen_set\.usd$/);
    expect(result.upAxis).toBe('Z');
    expect(result.meshes).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });
});
