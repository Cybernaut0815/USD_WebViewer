import { expect, type Page, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DisplayMode } from '../src/scene.ts';
import type { Section } from '../src/section.ts';
import type { UsdViewerElement } from '../src/viewer.ts';

const MOCK = '/?core=mock-core/&forceWebGL=1&src=mock.usda';

/** Goldens are of the 3D view; the stats overlay on top of it is checked as text, and shot.css hides the Section button. */
const shot = (page: Page) => ({ mask: [page.locator('usd-viewer .stats'), page.locator('usd-viewer .tools')], stylePath: fileURLToPath(new URL('shot.css', import.meta.url)) });

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

/** Client coordinates of world points in the view as drawn (the mock stage is Y up: its stage space is the world). */
const toScreen = (page: Page, points: number[][], settle = true) =>
  page.evaluate(async ({ points, settle }) => {
    const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
    if (settle) await viewer.idle(); // gizmos sit where they belong and have been drawn
    const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
    return points.map((v) => {
      const p = viewer.three.camera.position.clone().fromArray(v).project(viewer.three.camera);
      return [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height] as [number, number];
    });
  }, { points, settle });

/**
 * Drags a gizmo's handle on the axis through a world point along a world direction: grabbed 45 px out, moved px. With
 * settle false it starts at once, not after idle() (which waits for a frame). With touch a finger drags it, pressing
 * with no hover before (CDP touch events, which need no hasTouch context).
 */
async function dragAxis(page: Page, from: number[], along: number[], px = 60, { settle = true, touch = false } = {}) {
  const [center, ahead] = await toScreen(page, [from, from.map((x, i) => x + along[i])], settle);
  const length = Math.hypot(ahead[0] - center[0], ahead[1] - center[1]);
  const dir = [(ahead[0] - center[0]) / length, (ahead[1] - center[1]) / length];
  const at = (d: number) => [center[0] + dir[0] * d, center[1] + dir[1] * d] as const;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    const finger = (type: 'touchStart' | 'touchMove', d: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x: at(d)[0], y: at(d)[1] }] });
    await finger('touchStart', 45);
    for (let d = 50; d <= 45 + px; d += 5) await finger('touchMove', d);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return cdp.detach();
  }
  await page.mouse.move(...at(45));
  await page.mouse.down();
  for (let d = 50; d <= 45 + px; d += 5) await page.mouse.move(...at(d));
  await page.mouse.up();
}

/** Drags the move gizmo's X handle of a prim by 60 px along the screen direction of world +X, with a finger if touch. */
async function dragAlongX(page: Page, path: string, touch = false) {
  const world = await page.evaluate((path) => {
    const object = (document.querySelector('usd-viewer') as UsdViewerElement).three.objectsFor(path)[0];
    return object.getWorldPosition(object.position.clone()).toArray();
  }, path);
  await dragAxis(page, world, [1, 0, 0], 60, { touch });
}

test.describe('mock core', () => {
  test('renders the stage', async ({ page }) => {
    const errors = await open(page, MOCK);
    expect(errors).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-stage.png', shot(page));
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

  test('Esc selects nothing, as a click on empty space does', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Cube');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection)).toEqual([]);
    await expect(page.locator('usd-viewer .props .hint')).toBeVisible();
  });

  test('shift-click adds, ctrl-click removes, and the picker chooses the prim shown', async ({ page }) => {
    await open(page, MOCK);
    const picker = page.locator('usd-viewer .picker');
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await expect(picker).toBeHidden();
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click({ modifiers: ['Shift'] });
    await expect(page.locator('usd-viewer .row.selected')).toHaveCount(2);
    await expect(page.locator('usd-viewer .row.active')).toHaveText(/Light/);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Light');
    // With several prims selected the dropdown picks the one shown.
    await expect(picker).toBeVisible();
    await picker.selectOption('/World/Cube');
    await expect(page.locator('usd-viewer .row.active')).toHaveText(/Cube/);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Cube');
    // Shift-click on a selected prim only makes it active; Ctrl-click removes.
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click({ modifiers: ['Shift'] });
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Light');
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click({ modifiers: ['Control'] });
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection)).toEqual(['/World/Cube']);
    await expect(page.locator('usd-viewer .props .head strong')).toHaveText('Cube');
    await expect(picker).toBeHidden();
  });

  test('shift-drag up takes what the rectangle touches, down only what it covers; ctrl-drag removes', async ({ page }) => {
    await open(page, MOCK);
    const box = await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = viewer.three.objectsFor('/World/Cube')[0] as any;
      const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const b = cube.geometry.boundingBox.clone().applyMatrix4(cube.matrixWorld);
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < 8; i++) {
        const p = b.min.clone();
        if (i & 1) p.x = b.max.x;
        if (i & 2) p.y = b.max.y;
        if (i & 4) p.z = b.max.z;
        p.project(viewer.three.camera);
        xs.push(rect.left + ((p.x + 1) / 2) * rect.width);
        ys.push(rect.top + ((1 - p.y) / 2) * rect.height);
      }
      return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    });
    const selection = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).selection);
    const midX = (box.left + box.right) / 2;
    const drag = async (modifier: 'Shift' | 'Control', from: [number, number], to: [number, number]) => {
      await page.keyboard.down(modifier);
      await page.mouse.move(...from);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 5, from[1] + ((to[1] - from[1]) * i) / 5);
      await page.mouse.up();
      await page.keyboard.up(modifier);
    };
    // Downward over the left half only: the cube is not fully inside, so nothing is taken.
    await drag('Shift', [box.left - 4, box.top - 4], [midX, box.bottom + 4]);
    await page.waitForTimeout(300);
    expect(await selection()).toEqual([]);
    // Upward over the same half: touching is enough (an instance overlapping on screen may come along).
    await drag('Shift', [midX, box.bottom + 4], [box.left - 4, box.top - 4]);
    await expect.poll(selection).toContain('/World/Cube');
    // Ctrl with the same upward rectangle removes what it touches again.
    await drag('Control', [midX, box.bottom + 4], [box.left - 4, box.top - 4]);
    await expect.poll(selection).toEqual([]);
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
    await page.locator('usd-viewer .popup button', { hasText: 'Copy typed declaration' }).click();
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
    const edges = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = (viewer as any).viewport.sync.items.get(1);
      // Edges come from the core only once a wire mode asks for them; the stats count them all along.
      const before = { edges: cube.edges, stats: viewer.stats.edges };
      viewer.displayMode = 'plain-wire';
      await viewer.idle();
      return { before, after: !!cube.edges };
    });
    expect(edges).toEqual({ before: { edges: null, stats: 48 }, after: true });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-plain-wire.png', shot(page));
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.displayMode = 'wire';
      await viewer.idle();
    });
    // Face outlines only: no triangle diagonals, back edges seen through the hidden surface.
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-wire.png', shot(page));
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.displayMode = 'shaded';
      await viewer.idle();
    });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-stage.png', shot(page));
    expect(errors).toEqual([]);
  });

  test('value boxes copy on click; the menu copies a whole section', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    const copied = () => page.evaluate(() => (window as any).copied);
    await page.locator('usd-viewer .props tr', { hasText: 'Path' }).first().locator('.value').click();
    await expect.poll(copied).toBe('/World/Cube');
    const transform = page.locator('usd-viewer .props details', { has: page.locator('summary', { hasText: 'World transform' }) });
    await transform.locator('summary').click();
    await transform.locator('.value').first().click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Copy section as text' }).click();
    // Opening the section fetched the bounds (a subtree walk the panel does not pay for otherwise).
    await expect.poll(copied).toBe(
      'matrix4d worldTransform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1) )\ndouble3 boundsMin = (-0.5, -0.5, -0.5)\ndouble3 boundsMax = (0.5, 0.5, 0.5)',
    );
    // Primvars copy too, fetching the full value.
    await page.locator('usd-viewer .props tr', { hasText: 'displayColor' }).locator('.value').click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Copy typed declaration' }).click();
    await expect.poll(copied).toBe('color3f[] primvars:displayColor = [(0.8, 0.2, 0.2)]');
  });

  test('numeric arrays load on click, with Load all, or automatically', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    const value = page.locator('usd-viewer .props tr', { hasText: 'faceVertexCounts' }).locator('.value');
    const loadAll = page.locator('usd-viewer .props .load-all');
    await expect(value).toHaveText('load…');
    await loadAll.click();
    await expect(value).toHaveText('[4, 4, 4]');
    await expect(loadAll).toBeHidden();
    // The setting fills them on selection; Load all is not needed then.
    await page.locator('usd-viewer details.menu summary', { hasText: 'View' }).click();
    await page.locator('usd-viewer label', { hasText: 'Load array values automatically' }).click();
    await page.keyboard.press('Escape');
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click();
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await expect(value).toHaveText('[4, 4, 4]');
    await expect(loadAll).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('usd-viewer:layout')!).autoLoadArrays)).toBe(true);
  });

  test('panels hide, the splitter resizes, and the Help window lists the keys', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await open(page, MOCK);
    const left = page.locator('usd-viewer aside.left');
    const before = (await left.boundingBox())!.width;
    const split = (await page.locator('usd-viewer .left-split').boundingBox())!;
    await page.mouse.move(split.x + 2, split.y + 100);
    await page.mouse.down();
    await page.mouse.move(split.x + 62, split.y + 100, { steps: 4 });
    await page.mouse.up();
    const widened = (await left.boundingBox())!.width;
    expect(widened).toBeCloseTo(before + 60, -1);
    // Side panels keep their share of the window when it is resized; the timebar keeps its height.
    const timebar = (await page.locator('usd-viewer .timeline').boundingBox())!.height;
    await page.setViewportSize({ width: 1536, height: 800 });
    await expect.poll(async () => (await left.boundingBox())!.width).toBeCloseTo(widened * 1.5, -1);
    expect((await page.locator('usd-viewer .timeline').boundingBox())!.height).toBe(timebar);
    // The tabs on the viewport's borders show up only near the border, and hide and show the panels.
    const tab = page.locator('usd-viewer .left-split .toggle');
    const canvas = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await expect(tab).toHaveCSS('opacity', '0');
    await page.mouse.move(canvas.x + 10, canvas.y + canvas.height / 2);
    await expect(tab).toHaveCSS('opacity', '1');
    await tab.click();
    await expect(left).toBeHidden();
    await page.locator('usd-viewer .left-split .toggle').click();
    await expect(left).toBeVisible();
    const view = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.move(view.x + view.width / 2, view.y + view.height - 6); // near the bottom border
    await page.locator('usd-viewer .toggle.time').click();
    await expect(page.locator('usd-viewer .timeline')).toBeHidden();
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).panels = { hierarchy: false, timeline: false }));
    await expect(left).toBeHidden();
    await expect(page.locator('usd-viewer aside.right')).toBeVisible();
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('F1');
    await expect(page.locator('usd-viewer dialog.help')).toBeVisible();
    await expect(page.locator('usd-viewer dialog.help')).toContainText('Shift+drag up');
  });

  test('edited prims get a change marker, their parents a hollow one; hiding does not mark', async ({ page }) => {
    await open(page, MOCK);
    const cube = page.locator('usd-viewer .row', { hasText: 'Cube' });
    const world = page.locator('usd-viewer .row', { hasText: 'World' }).first();
    await expect(cube.locator('.changed')).toHaveText('');
    await cube.locator('.name').click();
    await page.keyboard.press('h');
    await expect(cube).toHaveClass(/dim/); // hidden, but not marked
    await expect(cube.locator('.changed')).toHaveText('');
    await expect(world.locator('.changed')).toHaveText('');
    await page.keyboard.press('Alt+h');
    await expect(cube).not.toHaveClass(/dim/);
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).usd.setAttribute('/World/Cube', 'size', 2));
    await expect(cube.locator('.changed')).toHaveText('◆');
    await expect(world.locator('.changed')).toHaveText('◇');
    await expect(cube.locator('.changed')).toHaveAttribute('title', 'Changed in this session');
  });

  test('alt+click adds a range of rows; shift+alt+click takes a level up with its subtree', async ({ page }) => {
    await open(page, MOCK);
    const state = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { selection: [...v.selection], active: v.active };
    });
    const row = (name: string) => page.locator('usd-viewer .row .name', { hasText: new RegExp(`^${name}$`) });
    await row('Cube').click();
    await row('Light').click({ modifiers: ['Alt'] });
    expect(await state()).toEqual({ selection: ['/World/Cube', '/World/Instances', '/World/Big', '/World/Light'], active: '/World/Light' });
    // Shift+Alt on Cube: World is the first unselected level up; it comes with everything below it.
    await row('Cube').click({ modifiers: ['Shift', 'Alt'] });
    await expect.poll(async () => (await state()).active).toBe('/World');
    const { selection } = await state();
    expect(selection).toContain('/World/Big/Child_0');
    // The 10,000 cap (World/Big has 50,000 children, so the walk stops inside it) plus Light from the
    // range, which comes after Big and is cut off; Cube, Instances and Big are in both.
    expect(selection.length).toBe(10000 + 1);
    await page.locator('usd-viewer .toolbar button', { hasText: '?' }).click();
    await expect(page.locator('usd-viewer dialog.help')).toContainText('Shift+Alt+click');
    await expect(page.locator('usd-viewer dialog.help')).toContainText('Alt+click (hierarchy)');
  });

  test('shift+ctrl click climbs the hierarchy; the prim menu clears edits', async ({ page }) => {
    await open(page, MOCK);
    const viewer = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { selection: v.selection, active: v.active };
    });
    const cube = page.locator('usd-viewer .row', { hasText: 'Cube' });
    await cube.locator('.name').click({ modifiers: ['Shift', 'Control'] });
    expect(await viewer()).toEqual({ selection: ['/World/Cube', '/World'], active: '/World' });
    // Edit, then Clear edits from the right-click menu: the marker goes, and Ctrl+Z brings the edit back.
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).usd.setAttribute('/World/Cube', 'size', 2));
    await expect(cube.locator('.changed')).toHaveText('◆');
    await cube.click({ button: 'right' });
    await page.locator('usd-viewer .popup button', { hasText: 'Clear edits' }).click();
    await expect(cube.locator('.changed')).toHaveText('');
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Control+z');
    await expect(cube.locator('.changed')).toHaveText('◆');
  });

  test('the background colour can be set and reset; the Colour sky uses it', async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await open(page, MOCK);
    const result = await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const before = v.backgroundColor;
      v.backgroundColor = '#336699';
      const set = v.backgroundColor;
      v.sky = 'colour';
      return { before, set, sky: v.sky };
    });
    expect(result).toEqual({ before: '#26282b', set: '#336699', sky: 'colour' });
    await page.locator('usd-viewer details.menu summary', { hasText: 'View' }).click();
    await page.locator('usd-viewer .dropdown button', { hasText: 'Reset' }).click();
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).backgroundColor)).toBe('#26282b');
  });

  test('the auto refinement budget follows the hardware unless set, and is remembered', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.getItem('kept') || (localStorage.clear(), sessionStorage.setItem('kept', '1')));
    await open(page, MOCK);
    const budget = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).refineBudget);
    const hardware = await budget();
    expect(hardware).toBeGreaterThanOrEqual(1.125e6);
    expect(hardware).toBeLessThanOrEqual(6e6);
    await page.locator('usd-viewer details.menu summary', { hasText: 'View' }).click();
    await page.locator('usd-viewer .dropdown input[title^="Auto budget"]').fill('1.5');
    await page.locator('usd-viewer .dropdown input[title^="Auto budget"]').dispatchEvent('change');
    expect(await budget()).toBe(1.5e6);
    await open(page, MOCK); // a fresh page load
    expect(await budget()).toBe(1.5e6); // remembered in this browser
    await page.locator('usd-viewer details.menu summary', { hasText: 'View' }).click();
    await page.locator('usd-viewer .dropdown button', { hasText: 'Hardware default' }).click();
    expect(await budget()).toBe(hardware);
  });

  test('the stats show the frame rate and the Help window explains the hierarchy symbols', async ({ page }) => {
    await open(page, MOCK);
    await expect(page.locator('usd-viewer .stats')).toContainText('FPS');
    await expect(page.locator('usd-viewer .stats')).toContainText(/Frame\d+\.\d ms/);
    const stats = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).stats);
    expect(stats.frameMs).toBeGreaterThan(0);
    await page.locator('usd-viewer .toolbar button', { hasText: '?' }).click();
    await expect(page.locator('usd-viewer dialog.help')).toContainText('Has a payload');
    await expect(page.locator('usd-viewer dialog.help')).toContainText('Changed in this session');
  });

  test('menus drop down without moving the toolbar, one at a time', async ({ page }) => {
    await open(page, MOCK);
    const summary = (name: string) => page.locator('usd-viewer details.menu summary', { hasText: name });
    const places = async () => Promise.all(['File', 'Edit', 'View', 'Save'].map(async (n) => (await page.locator('usd-viewer .toolbar > *', { hasText: n }).first().boundingBox())!));
    const before = await places();
    await summary('View').click();
    await expect(page.locator('usd-viewer details.menu[open] .dropdown')).toBeVisible();
    expect(await places()).toEqual(before);
    await summary('Edit').click();
    await expect(page.locator('usd-viewer details.menu[open]')).toHaveCount(1);
    await expect(page.locator('usd-viewer details.menu[open] summary')).toHaveText('Edit');
    const box = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height - 20);
    await expect(page.locator('usd-viewer details.menu[open]')).toHaveCount(0);
  });

  test('the search clear button empties the field and restores the tree', async ({ page }) => {
    await open(page, MOCK);
    const search = page.locator('usd-viewer .search input');
    const clear = page.locator('usd-viewer .search .clear');
    await expect(clear).toBeHidden();
    await search.fill('Cube');
    await expect(page.locator('usd-viewer .row', { hasText: 'Light' })).toHaveCount(0);
    await clear.click();
    await expect(search).toHaveValue('');
    await expect(clear).toBeHidden();
    await expect(page.locator('usd-viewer .row', { hasText: 'Light' })).toHaveCount(1);
  });

  test('the free camera switches to orthographic and takes a focal length', async ({ page }) => {
    await open(page, MOCK);
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.cameraSettings = { focalLength: 85 };
      const fov = (viewer.three.camera as any).fov;
      viewer.cameraSettings = { projection: 'orthographic' };
      await viewer.idle();
      const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const cube = viewer.three.objectsFor('/World/Cube')[0];
      const p = cube.getWorldPosition(cube.position.clone()).project(viewer.three.camera);
      const hit = await viewer.pick(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
      return { fov, type: viewer.three.camera.type, hit: hit?.path, settings: viewer.cameraSettings.projection };
    });
    expect(result.fov).toBeCloseTo(16.07, 1);
    expect(result).toMatchObject({ type: 'OrthographicCamera', hit: '/World/Cube', settings: 'orthographic' });
  });

  test('a host sets the free view (perspective or orthographic) and orbiting goes on from it', async ({ page }) => {
    await open(page, MOCK);
    const round = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const r = (v: number[]) => v.map((x) => +x.toFixed(4));
      viewer.view = { eye: [4, 3, 5], target: [0, 0.5, 0], fov: 30, projection: 'perspective', height: 1 };
      const p = viewer.view;
      viewer.view = { eye: [0, 10, 0.001], target: [0, 0, 0], fov: 30, projection: 'orthographic', height: 2.5 };
      await viewer.idle();
      const o = viewer.view;
      return { p: [r(p.eye), r(p.target), +p.fov.toFixed(3), p.projection], o: [r(o.target), o.projection, +o.height.toFixed(3), viewer.three.camera.type] };
    });
    expect(round.p).toEqual([[4, 3, 5], [0, 0.5, 0], 30, 'perspective']);
    expect(round.o).toEqual([[0, 0, 0], 'orthographic', 2.5, 'OrthographicCamera']);
    // Back to perspective, then a drag orbits around the target that was set.
    await page.evaluate(() => { (document.querySelector('usd-viewer') as UsdViewerElement).view = { eye: [4, 3, 5], target: [0, 0.5, 0], fov: 30, projection: 'perspective', height: 1 }; });
    const box = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view);
    expect(after.target.map((x) => +x.toFixed(4))).toEqual([0, 0.5, 0]);
    expect(after.eye.map((x) => +x.toFixed(4))).not.toEqual([4, 3, 5]);
  });

  test('the timebar steps frames and a sky replaces the background', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('.');
    await page.keyboard.press('.');
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).time)).toBe(3);
    await page.locator('usd-viewer .timeline button[title^="Previous"]').click();
    await expect(page.locator('usd-viewer .timeline input[type=number]')).toHaveValue('2');
    const background = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.sky = 'industrial';
      for (let i = 0; i < 100 && !viewer.three.scene.background; i++) await new Promise((r) => setTimeout(r, 50));
      const withSky = !!viewer.three.scene.background;
      viewer.sky = null;
      return { withSky, without: !!viewer.three.scene.background };
    });
    expect(background).toEqual({ withSky: true, without: false });
  });

  test('selection-wire modes outline only the selection in red', async ({ page }) => {
    const errors = await open(page, MOCK);
    for (const mode of ['plain-selwire', 'shaded-selwire'] as const) {
      await page.evaluate(async (mode) => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        viewer.select('/World/Cube');
        viewer.displayMode = mode;
        await viewer.idle();
      }, mode);
      await expect(page.locator('usd-viewer canvas')).toHaveScreenshot(`mock-${mode}.png`, shot(page));
    }
    expect(errors).toEqual([]);
  });

  test('stats count the USD meshes, instances included', async ({ page }) => {
    await open(page, MOCK);
    const stats = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).stats);
    // The cube plus three instances of it: 8 points, 6 quads, 12 edges each, not 12 triangles.
    expect(await stats()).toMatchObject({ meshes: 4, points: 32, faces: 24, edges: 48, materials: 0, textures: 0 });
    await expect(page.locator('usd-viewer .stats')).toContainText('Faces24');
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).purposes = ['render']));
    expect((await stats()).meshes).toBe(0);
  });

  test('H hides the selection in the session layer, Shift+H the rest, Alt+H shows all', async ({ page }) => {
    await open(page, MOCK);
    const state = () =>
      page.evaluate(async () => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        await viewer.idle();
        return { meshes: viewer.stats.meshes, dirty: viewer.dirty };
      });
    const cubeRow = page.locator('usd-viewer .row', { hasText: 'Cube' });
    await cubeRow.locator('.name').click(); // keys work with the tree focused
    // The key handlers start an RPC, so poll until its flush has landed.
    await page.keyboard.press('h');
    await expect.poll(state).toEqual({ meshes: 3, dirty: false });
    await expect(cubeRow).toHaveClass(/dim/);
    // A pick does not even raycast the hidden cube (three would test every triangle of a hidden mesh).
    const raycasts = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = viewer.three.objectsFor('/World/Cube')[0];
      let calls = 0;
      const raycast = cube.raycast;
      cube.raycast = (...args) => (calls++, raycast.apply(cube, args));
      const p = cube.getWorldPosition(cube.position.clone()).project(viewer.three.camera);
      const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      await viewer.pick(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
      cube.raycast = raycast;
      return calls;
    });
    expect(raycasts).toBe(0);
    await page.keyboard.press('Alt+h');
    await expect.poll(state).toEqual({ meshes: 4, dirty: false });
    await expect(cubeRow).not.toHaveClass(/dim/);
    await page.locator('usd-viewer .row .name', { hasText: 'Light' }).click();
    await page.keyboard.press('Shift+h');
    await expect.poll(state).toEqual({ meshes: 3, dirty: false });
    await page.keyboard.press('Control+z');
    await expect.poll(state).toEqual({ meshes: 4, dirty: false });
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

  test('the move gizmo drags the selected prim, as far by finger as by mouse, and keeps one undo step', async ({ page }) => {
    await open(page, MOCK);
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).tool = 'translate'));
    // A finger presses with no hover before it: the gizmo takes the axis in the press, and its drag plane must turn to it
    // there, not in the next frame. This drag goes first, as after an X drag the plane stays turned for X and a finger
    // drag would go right without that.
    await dragAlongX(page, '/World/Cube', true);
    const touched = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.idle();
      const x = viewer.three.objectsFor('/World/Cube')[0].matrix.elements[12];
      await viewer.undo();
      await viewer.idle();
      return x;
    });
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
    expect(touched).toBeCloseTo(result.moved, 6);
    expect(result.canUndo).toBe(true);
    expect(result.after).toBeCloseTo(0, 3);
    expect(result.selection).toEqual(['/World/Cube']);
  });

  test('N toggles navigate, where W flies the camera forward and E R do not pick a gizmo', async ({ page }) => {
    await open(page, MOCK);
    const camera = () =>
      page.evaluate(() => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        const c = viewer.three.camera;
        return { tool: viewer.tool, position: c.position.toArray(), forward: c.getWorldDirection(c.position.clone()).toArray() };
      });
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('n');
    await page.keyboard.press('e');
    await page.keyboard.press('r');
    const before = await camera();
    const ahead = async () => (await camera()).position.reduce((sum, p, i) => sum + (p - before.position[i]) * before.forward[i], 0);
    await page.keyboard.down('w');
    // Held until it has flown, not for a fixed time: a step counts at most 0.1 s, and slow runners draw slower than that.
    await expect.poll(ahead).toBeGreaterThan(0.1);
    await page.keyboard.up('w');
    expect(before.tool).toBe('navigate');
    expect((await camera()).tool).toBe('navigate');
    await page.keyboard.press('n');
    expect((await camera()).tool).toBe('select');
  });

  test('Navigate from the view buttons: mouse look while held, wheel and Shift set the speed', async ({ page }) => {
    await open(page, MOCK);
    const view = () =>
      page.evaluate(() => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        const c = viewer.three.camera;
        return { tool: viewer.tool, position: c.position.toArray(), forward: c.getWorldDirection(c.position.clone()).toArray() };
      });
    const navigate = page.locator('usd-viewer .tools button[value="navigate"]');
    await navigate.click();
    await expect(navigate).toHaveClass(/on/);
    const speed = page.locator('usd-viewer .fly-speed');
    await expect(speed).toHaveText('Speed ×1.0');
    const box = (await page.locator('usd-viewer canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await expect(speed).toHaveText('Speed ×1.6'); // two notches of 1.25
    await page.keyboard.down('Shift');
    await expect(speed).toHaveText('Speed ×6.3 (Shift)');
    await page.keyboard.up('Shift');
    // Holding the button turns the view in place; letting go leaves the mouse free.
    const before = await view();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 150, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const after = await view();
    after.position.forEach((p, i) => expect(p).toBeCloseTo(before.position[i], 6));
    expect(after.forward.reduce((sum, f, i) => sum + f * before.forward[i], 0)).toBeLessThan(0.95);
    await page.mouse.move(box.x + 10, box.y + 10, { steps: 3 });
    expect((await view()).forward).toEqual(after.forward);
    await page.locator('usd-viewer .tools button[value="select"]').click();
    expect((await view()).tool).toBe('select');
    await expect(speed).toHaveCount(0);
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

  test('embedding: readonly keys, render items, overlay framing, transparent background, bare layout', async ({ page }) => {
    await open(page, `${MOCK}&panels=none`);
    await page.evaluate(() => {
      document.querySelector('usd-viewer')!.setAttribute('readonly', '');
      // Handled keys are prevented, so defaultPrevented tells which ones the viewer acted on.
      document.addEventListener('keydown', (e) => e.key !== 'Alt' && ((window as any).handled ??= []).push(e.defaultPrevented));
    });
    await page.locator('usd-viewer canvas').focus();
    for (const key of ['h', 'r', 'f', 'Alt+h']) await page.keyboard.press(key);
    expect(await page.evaluate(() => (window as any).handled)).toEqual([true, false, true, true]); // hiding and framing; no Scale
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.backgroundColor = 'transparent';
      const pixel = new OffscreenCanvas(1, 1).getContext('2d')!;
      pixel.drawImage(await createImageBitmap(await viewer.screenshot()), -2, -2); // (2, 2) is background
      const far = viewer.three.objectsFor('/World/Cube')[0].clone(); // an overlay object far to the side
      far.matrix.setPosition(50, 0, 0);
      far.matrixWorldNeedsUpdate = true; // a frozen matrix (matrixAutoUpdate off) edited by hand
      const floor = far.clone(); // opted out of framing: it must not pull the camera back
      floor.matrix.setPosition(-5000, 0, 0);
      floor.matrixWorldNeedsUpdate = true;
      floor.userData.frame = false;
      viewer.three.overlay.add(far, floor);
      viewer.tool = 'scale'; // readonly: no Scale (Move and Rotate act on sections only)
      viewer.frame();
      await viewer.idle(); // drawn: the camera matrices are current
      const ndc = far.getWorldPosition(far.position.clone()).project(viewer.three.camera);
      const away = floor.getWorldPosition(floor.position.clone()).project(viewer.three.camera);
      const distance = () => { const v = viewer.view; return Math.hypot(...v.eye.map((e, i) => e - v.target[i])); };
      const wide = distance();
      viewer.style.width = '160px'; // narrower than tall: framing fits the width
      viewer.style.height = '600px';
      for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame); // resized
      viewer.frame();
      await viewer.idle();
      const narrow = far.getWorldPosition(far.position.clone()).project(viewer.three.camera);
      viewer.style.width = '0px'; // no width (a collapsed column): framing fits the height, as for a wide one
      for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
      viewer.frame();
      const collapsed = Math.abs(distance() / wide - 1) < 1e-6;
      return {
        tool: viewer.tool,
        unframed: Math.abs(away.x) > 1 || Math.abs(away.y) > 1,
        meshes: viewer.three.items().filter((i) => i.kind === 'mesh').map((i) => i.path),
        background: viewer.backgroundColor,
        alpha: pixel.getImageData(0, 0, 1, 1).data[3],
        framed: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1,
        narrow: Math.abs(narrow.x) < 1 && Math.abs(narrow.y) < 1,
        collapsed,
        bare: viewer.shadowRoot!.querySelector('canvas')!.clientWidth === viewer.clientWidth,
      };
    });
    expect(result).toEqual({ tool: 'select', unframed: true, meshes: ['/World/Cube', '/World/Instances/Proto'], background: 'transparent', alpha: 0, framed: true, narrow: true, collapsed: true, bare: true });
  });

  test('sections cut the view with planes and boxes, and leave the stage and its objects alone', async ({ page }) => {
    const errors = await open(page, MOCK);
    const canvas = page.locator('usd-viewer canvas');
    // What a section must not touch: the edit state, the render items and the counts.
    const state = () =>
      page.evaluate(() => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        const { meshes, points, faces, edges, materials, textures } = viewer.stats;
        const ids = (objects: { uuid: string }[]) => objects.map((o) => o.uuid);
        return { dirty: viewer.dirty, items: ids(viewer.three.items().flatMap((i) => i.object ?? [])), cube: ids(viewer.three.objectsFor('/World/Cube')), stats: [meshes, points, faces, edges, materials, textures] };
      });
    const before = await state();
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const events: unknown[] = ((window as any).events = []);
      for (const type of ['primschange', 'dirtychange', 'sectionchange']) viewer.addEventListener(type, (e) => events.push([type, (e as CustomEvent).detail]));
    });
    const show = (section: Section) =>
      page.evaluate(async (section) => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        viewer.sectionHandles = false; // the cut alone
        viewer.section = section;
        await viewer.idle();
        return viewer.section;
      }, section);
    // A plane through the cube keeps x <= 0: the cut cube shows its grey inside.
    await show({ on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] });
    await expect(canvas).toHaveScreenshot('mock-section-plane.png', shot(page));
    // A box that shows only its inside: a slab of the cube.
    const slab = await show({ on: true, planes: [], boxes: [{ keep: 'inside', corners: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], bottom: -0.25, top: 0.25 }] });
    expect(slab.boxes[0].corners).toEqual([[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]]); // counter-clockwise seen from above
    await expect(canvas).toHaveScreenshot('mock-section-box.png', shot(page));
    // A box cut out of the front and below, and a plane above the cube.
    await show({ on: true, planes: [{ point: [0, 2, 0], normal: [0, -1, 0] }], boxes: [{ keep: 'outside', corners: [[-0.3, 0, 0], [3, 0, 0], [3, 0, 3], [-0.3, 0, 3]], bottom: -1, top: 0.2 }] });
    await expect(canvas).toHaveScreenshot('mock-section-cut.png', shot(page));
    // A concave footprint: an arrowhead whose notch leaves out the middle instance and the back of the cube.
    const arrow: Section = { on: true, planes: [], boxes: [{ keep: 'inside', corners: [[-2.6, 0, 2.6], [0, 0, -0.8], [2.6, 0, 2.6], [0, 0, 1.2]], bottom: -1, top: 3 }] };
    await show(arrow);
    await expect(canvas).toHaveScreenshot('mock-section-concave.png', shot(page));
    // Off keeps the entries and shows everything; cleared is the stage as before.
    expect((await show({ ...arrow, on: false })).boxes).toHaveLength(1);
    await expect(canvas).toHaveScreenshot('mock-stage.png', shot(page));
    await show({ on: true, planes: [], boxes: [] });
    await expect(canvas).toHaveScreenshot('mock-stage.png', shot(page));
    expect(await state()).toEqual(before);
    expect(await page.evaluate(() => (window as any).events)).toEqual(Array(6).fill(['sectionchange', { source: 'api' }]));
    // Opening a stage clears the section before hosts hear stageopen: one a host sets there stays.
    const plane = { point: [0, 0, 0], normal: [-1, 0, 0] } as Section['planes'][number];
    const reopened = await page.evaluate(async (plane) => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const sources: string[] = [];
      viewer.addEventListener('sectionchange', (e) => sources.push((e as CustomEvent).detail.source));
      viewer.section = { on: true, planes: [{ ...plane, normal: [1, 0, 0] }], boxes: [] };
      viewer.addEventListener('stageopen', () => (viewer.section = { on: true, planes: [plane], boxes: [] }), { once: true });
      await viewer.open('mock.usda');
      return { sources, section: viewer.section };
    }, plane);
    expect(reopened).toEqual({ sources: ['api', 'stage', 'api'], section: { on: true, planes: [plane], boxes: [] } });
    expect(errors).toEqual([]);
  });

  test('picking goes through what a section cuts away, a marquee skips it, and hosts section their own materials', async ({ page }) => {
    await open(page, MOCK);
    const warnings: string[] = [];
    page.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      // Straight at the front: the middle instance stands in front of the cube.
      viewer.view = { eye: [0, 0, 10], target: [0, 0, 0], fov: 30, projection: 'perspective', height: 1 };
      await viewer.idle();
      const rect = viewer.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const centre = async () => (await viewer.pick(rect.left + rect.width / 2, rect.top + rect.height / 2))?.path ?? null;
      const whole = await centre();
      viewer.section = { on: true, planes: [], boxes: [{ keep: 'outside', corners: [[-0.75, 0, 1.25], [0.75, 0, 1.25], [0.75, 0, 2.75], [-0.75, 0, 2.75]], bottom: -1, top: 1 }] };
      const behind = await centre();
      const point = viewer.three.camera.position.clone();
      const kept = [viewer.three.keeps(point.set(0, 0, 2)), viewer.three.keeps(point.set(0, 0, 0))];
      viewer.section = { on: true, planes: [{ point: [0, 0, -1], normal: [0, 0, -1] }], boxes: [] };
      const nothing = await centre();
      // Host materials: a NodeMaterial is sectioned like the viewer's own; anything else comes back untouched.
      const host = new ((viewer.three.objectsFor('/World/Cube')[0] as any).material.constructor)();
      const registered = [Object.hasOwn(host, 'section'), viewer.three.section(host) === host && Object.hasOwn(host, 'section') && host.section];
      const other = { type: 'MeshBasicMaterial' } as any;
      return { whole, behind, kept, nothing, registered, refused: viewer.three.section(other) === other && !('section' in other) };
    });
    expect(result).toEqual({ whole: '/World/Instances', behind: '/World/Cube', kept: [false, true], nothing: null, registered: [false, true], refused: true });
    expect(warnings.filter((w) => w.includes('only NodeMaterials can be sectioned'))).toHaveLength(1);
    // A marquee over everything takes what is not provably cut away: first with a box cut out around the cube.
    const selection = () => page.evaluate(() => [...(document.querySelector('usd-viewer') as UsdViewerElement).selection].sort());
    const marquee = async () => {
      const box = (await page.locator('usd-viewer canvas').boundingBox())!;
      const at = (i: number) => [box.x + box.width - 4 - ((box.width - 8) * i) / 5, box.y + box.height - 4 - ((box.height - 8) * i) / 5] as const;
      await page.keyboard.down('Shift');
      await page.mouse.move(...at(0));
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(...at(i));
      await page.mouse.up();
      await page.keyboard.up('Shift');
    };
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.view = { eye: [4, 3, 6], target: [0, 0.5, 0.5], fov: 50, projection: 'perspective', height: 1 };
      viewer.section = { on: true, planes: [], boxes: [{ keep: 'outside', corners: [[-0.6, 0, -0.6], [0.6, 0, -0.6], [0.6, 0, 0.6], [-0.6, 0, 0.6]], bottom: -0.6, top: 0.6 }] };
    });
    await marquee();
    await expect.poll(selection).toEqual(['/World/Instances']);
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.select(null);
      viewer.section = { on: false, planes: [], boxes: [] };
    });
    await marquee();
    await expect.poll(selection).toEqual(['/World/Cube', '/World/Instances']);
  });

  test('the first section arms every material once; later sections rebuild nothing and leave the shadow map alone', async ({ page }) => {
    await open(page, MOCK);
    // Every display mode (the type keeps the list complete), shaded-selwire last: the sections below are drawn in it.
    const none: Record<DisplayMode, string[]> = { shaded: [], 'shaded-wire': [], plain: [], 'plain-wire': [], 'plain-selwire': [], wire: [], 'shaded-selwire': [] };
    const result = await page.evaluate(async (list) => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const renderer = viewer.three.renderer as any;
      // 64 cubes with edges below the stage: a batch, whose looks and lines are sectioned too.
      const g = (viewer.three.objectsFor('/World/Cube')[0] as any).geometry;
      const index = g.index.array as Uint32Array;
      const edges = new Uint32Array([...index].flatMap((_, t) => (t % 3 ? [] : [index[t], index[t + 1], index[t + 1], index[t + 2], index[t + 2], index[t]])));
      const rids = Array.from({ length: 64 }, (_, i) => 500 + i);
      viewer.session.emit('delta', {
        meshes: rids.map((rid) => ({
          rid, path: `/World/Batched/C${rid}`, purpose: 'default', indices: new Uint32Array(index), positions: new Float32Array(g.attributes.position.array),
          normals: new Float32Array(g.attributes.normal.array), counts: { points: 8, faces: 6, edges: 12 }, edges: new Uint32Array(edges),
          displayColor: [0.6, 0.6, 0.3], subsets: null, material: 0, instances: null,
        })),
        xforms: { rids: new Uint32Array(rids), matrices: new Float64Array(rids.flatMap((_, i) => [0.3, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0.3, 0, (i % 8) * 0.4 - 1.4, -1.5, Math.floor(i / 8) * 0.4 - 1.4, 1])) },
      } as any);
      await viewer.idle();
      if (!viewer.three.root.children.some((o: any) => o.isBatch)) return 'no batch';
      // Materials never drawn (wire's surface, HIDDEN) are not sectioned.
      const unsectioned = () => {
        const missing: string[] = [];
        viewer.three.root.traverse((o: any) => {
          for (const m of [o.material ?? []].flat()) if (m.isNodeMaterial && m.visible && !(Object.hasOwn(m, 'section') && m.section)) missing.push(`${o.type} ${m.type}`);
        });
        return missing;
      };
      viewer.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
      viewer.select(['/World/Cube', '/World/Instances']);
      const modes: Record<string, string[]> = {};
      for (const mode of list) {
        viewer.displayMode = mode;
        await viewer.idle();
        modes[mode] = unsectioned();
      }
      // Armed: from here on a section is a uniform write.
      let built = 0;
      renderer.debug.onNodeBuilderCreated = () => built++;
      const pipelines = renderer._pipelines.caches.size;
      let sun: any = null;
      viewer.three.scene.traverse((o: any) => o.isDirectionalLight && o.castShadow && (sun = o));
      const planes = Array.from({ length: 8 }, (_, i) => ({ point: [0, -2, 0], normal: [Math.cos(i), 0.2, Math.sin(i)] }));
      const boxes = Array.from({ length: 8 }, (_, i) => ({ keep: i % 2 ? 'inside' : 'outside', corners: [[i - 4, 0, -1], [i - 3, 0, -1], [i - 3, 0, 1], [i - 4, 0, 1]], bottom: -1, top: 1 }));
      const flip = (keep: string) => boxes.map((b) => ({ ...b, keep: keep === 'flip' ? (b.keep === 'inside' ? 'outside' : 'inside') : keep }));
      const counts = (n: number) => ({ on: true, planes: planes.slice(0, n), boxes: boxes.slice(0, n) });
      const steps = [
        ...[0, 1, 2, 4, 8].map(counts),
        ...['flip', 'inside', 'outside'].map((keep) => ({ on: true, planes, boxes: flip(keep) })),
        ...[false, true, false, true].map((on) => ({ on, planes, boxes })),
        ...[7, 6, 5, 4, 3, 2, 1, 0].map(counts),
      ] as Section[];
      let changes = 0;
      let shadow = 0;
      viewer.addEventListener('sectionchange', () => changes++);
      for (const step of steps) {
        viewer.section = step;
        shadow += sun.shadow.needsUpdate ? 1 : 0;
        await viewer.idle();
      }
      renderer.debug.onNodeBuilderCreated = null;
      return { modes, steps: steps.length, changes, built, pipelines: renderer._pipelines.caches.size - pipelines, shadow };
    }, Object.keys(none) as DisplayMode[]);
    expect(result).toEqual({ modes: none, steps: 20, changes: 20, built: 0, pipelines: 0, shadow: 0 });
  });

  test('the first section on a page is built off-frame: no frame builds a shader, then the view shows the section', async ({ page }) => {
    const errors = await open(page, MOCK);
    const built = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const renderer = viewer.three.renderer as any;
      const render = renderer.render;
      const built = { inRender: 0, all: 0 };
      let depth = 0; // a shadow pass renders inside a render
      renderer.render = (...args: unknown[]) => {
        depth++;
        try {
          return render.apply(renderer, args);
        } finally {
          depth--;
        }
      };
      renderer.debug.onNodeBuilderCreated = () => (built.all++, depth && built.inRender++);
      viewer.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
      await viewer.idle();
      delete renderer.render;
      renderer.debug.onNodeBuilderCreated = null;
      return built;
    });
    expect(built.inRender).toBe(0); // the plane's outline and dot included
    expect(built.all).toBeGreaterThan(0); // the warm-up built them
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).sectionHandles = false)); // the cut alone
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-section-plane.png', shot(page));
    expect(errors).toEqual([]);
  });

  test('a transparent double-sided material in view at the first section draws as one built in a frame, also after leaving the scene meanwhile', async ({ page }) => {
    const errors = await open(page, MOCK);
    const same = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      // A lit see-through shell around the cube: three draws its back faces, then its front faces.
      const cube = viewer.three.objectsFor('/World/Cube')[0] as any;
      const shell = cube.clone();
      shell.material = viewer.three.section(cube.material.clone());
      Object.assign(shell.material, { transparent: true, opacity: 0.5, side: 2 }); // DoubleSide
      cube.getWorldPosition(shell.position);
      shell.scale.setScalar(1.3);
      viewer.three.overlay.add(shell);
      await viewer.idle();
      viewer.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
      viewer.three.overlay.remove(shell); // out of the scene until the section is built and shown
      await viewer.idle();
      viewer.three.overlay.add(shell);
      await viewer.idle();
      const image = async () => new Uint8Array(await (await viewer.screenshot()).arrayBuffer()).join();
      const warmed = await image();
      shell.material.needsUpdate = true; // built again in a frame, pass by pass
      await viewer.idle();
      return warmed === (await image());
    });
    expect(same).toBe(true);
    expect(errors).toEqual([]);
  });

  test('what goes for good while the first section builds off-frame is not built and kept', async ({ page }) => {
    const errors = await open(page, MOCK);
    const result = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const renderer = viewer.three.renderer as any;
      // Render objects of objects out of the scene (the renderer's own ones: background, output, environment), and
      // the geometries three holds.
      const count = () => {
        let out = 0;
        for (const { object } of renderer._objects._renderObjects) {
          let o = object;
          while (o && o !== viewer.three.scene) o = o.parent;
          if (!o) out++;
        }
        return { out, geometries: renderer.info.memory.geometries };
      };
      // The viewer's edge and highlight proxies, and a host mesh with its own geometry.
      viewer.displayMode = 'shaded-wire';
      viewer.select(['/World/Cube', '/World/Instances']);
      const cube = viewer.three.objectsFor('/World/Cube')[0] as any;
      const paint = new cube.constructor(cube.geometry.clone(), viewer.three.section(cube.material.clone()));
      viewer.three.overlay.add(paint);
      viewer.sectionHandles = false; // no outline geometry to count
      await viewer.idle();
      const before = count();
      // In the first section's task, so all of them are queued for its build: the viewer releases the proxies, the
      // host drops its mesh for good.
      viewer.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
      viewer.displayMode = 'shaded';
      paint.removeFromParent();
      paint.geometry.dispose();
      paint.dispatchEvent({ type: 'dispose' });
      await viewer.idle();
      return { before, after: count() };
    });
    expect(result.after).toEqual({ out: result.before.out, geometries: result.before.geometries - 1 });
    expect(errors).toEqual([]);
  });

  test('a section on one viewer leaves another viewer on the same page as it was', async ({ page }) => {
    await open(page, MOCK);
    const images = await page.evaluate(async () => {
      const a = document.querySelector('usd-viewer') as UsdViewerElement;
      const holder = document.createElement('div');
      holder.innerHTML = '<usd-viewer core-url="mock-core/" force-webgl panels="none" src="mock.usda" style="height: 320px"></usd-viewer>';
      const b = holder.firstElementChild as UsdViewerElement;
      document.body.append(b);
      await b.ready;
      if (!b.stage) await new Promise((resolve) => b.addEventListener('stageopen', resolve, { once: true }));
      await b.idle();
      const image = async (viewer: UsdViewerElement) => new Uint8Array(await (await viewer.screenshot()).arrayBuffer()).join();
      const before = [await image(a), await image(b)];
      a.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
      await a.idle();
      const after = [await image(a), await image(b)];
      return { a: before[0] === after[0], b: before[1] === after[1] };
    });
    expect(images).toEqual({ a: false, b: true });
  });

  test('the section gizmo moves box corners only across, faces only up and down, and refuses a crossing footprint', async ({ page }) => {
    const errors = await open(page, MOCK);
    const box = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).section.boxes[0]);
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const events: unknown[] = ((window as any).events = []);
      const handles = () => (viewer.sectionGizmo as { handles?: number[] } | null)?.handles ?? null; // null: detached
      for (const type of ['sectionchange', 'sectiongizmochange', 'selectionchange', 'primschange', 'dirtychange']) {
        viewer.addEventListener(type, (e) => events.push([type, type === 'sectiongizmochange' ? handles() : ((e as CustomEvent).detail?.source ?? null)]));
      }
      viewer.section = { on: true, planes: [], boxes: [{ keep: 'inside', corners: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], bottom: -0.5, top: 0.5 }] };
      viewer.sectionGizmo = { box: 0 };
    });
    const start = await box(); // counter-clockwise seen from above: corner 0 stays at x -1, z -1, corner 3 is x 1, z -1
    // Every handle starts chosen; Esc clears them, and a click on corner 0's top dot chooses that vertical edge alone.
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Escape');
    await page.mouse.click(...(await toScreen(page, [[-1, 0.5, -1]]))[0]);
    // The value carries the choice; set after null, the value read brings it back, so the drag moves that edge alone.
    // A value set keeps only the integers 0-5 of its handles, once each.
    const values = await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const read = viewer.sectionGizmo;
      viewer.sectionGizmo = { box: 0, handles: [5, 2, 5, 9, -1, 1.5, '3' as any] };
      const odd = viewer.sectionGizmo;
      viewer.sectionGizmo = null;
      viewer.sectionGizmo = read;
      return [read, odd];
    });
    expect(values).toEqual([{ box: 0, rotate: false, handles: [0] }, { box: 0, rotate: false, handles: [2, 5] }]);
    await dragAxis(page, [-1, 0, -1], [1, 0, 0]); // the gizmo sits in the middle of the edge
    const moved = await box();
    expect(moved.corners[0][0]).toBeGreaterThan(-0.8);
    expect([moved.corners[0][1], moved.bottom, moved.top]).toEqual([0, -0.5, 0.5]); // in plan only
    expect(moved.corners.slice(1)).toEqual(start.corners.slice(1));
    // The top face's dot sits on the footprint's middle: chosen alone, the gizmo moves it up only.
    const middle = [0, 2].map((i) => moved.corners.reduce((sum, c) => sum + c[i], 0) / 4);
    await page.keyboard.press('Escape');
    await page.mouse.click(...(await toScreen(page, [[middle[0], 0.5, middle[1]]]))[0]);
    await dragAxis(page, [middle[0], 0.5, middle[1]], [0, 1, 0]);
    const raised = await box();
    expect(raised.top).toBeGreaterThan(0.7);
    expect([raised.bottom, raised.corners]).toEqual([-0.5, moved.corners]);
    // Dragged far along +X, corner 0 would cross corner 3: it stops at the last footprint that worked.
    const [x, , z] = raised.corners[0];
    await page.keyboard.press('Escape');
    await page.mouse.click(...(await toScreen(page, [[x, raised.top, z]]))[0]);
    await dragAxis(page, [x, (raised.bottom + raised.top) / 2, z], [1, 0, 0], 200);
    const refused = await box();
    expect(refused.corners[0][0]).toBeGreaterThan(x);
    expect(refused.corners[0][0]).toBeLessThan(1);
    expect([refused.bottom, refused.top, refused.corners.slice(1)]).toEqual([raised.bottom, raised.top, start.corners.slice(1)]);
    // Attached afresh, every handle is chosen again. Dragged up and across by the gizmo's middle, the footprint moves
    // only in plan and the bottom and top rise together; no frame of the drag redraws the shadows.
    await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.sectionGizmo = { box: 0 };
      let sun: any = null;
      viewer.three.scene.traverse((o: any) => o.isDirectionalLight && o.castShadow && (sun = o));
      (window as any).redraws = 0;
      viewer.three.beforeRender.add(() => void (sun.shadow.needsUpdate && (window as any).redraws++));
    });
    const mean = [0, 2].map((i) => refused.corners.reduce((sum, c) => sum + c[i], 0) / 4);
    const [grip] = await toScreen(page, [[mean[0], (refused.bottom + refused.top) / 2, mean[1]]]);
    await page.mouse.move(...grip);
    await page.mouse.down();
    for (let d = 5; d <= 40; d += 5) await page.mouse.move(grip[0] + d, grip[1] - d);
    await page.mouse.up();
    const whole = await box();
    const shift = whole.corners.map((c, k) => c.map((v, i) => v - refused.corners[k][i]));
    expect(Math.hypot(shift[0][0], shift[0][2])).toBeGreaterThan(0.05);
    for (const [dx, dy, dz] of shift) expect([dx - shift[0][0], dy, dz - shift[0][2]].map((v) => Math.abs(v) < 1e-9)).toEqual([true, true, true]);
    expect(whole.bottom - refused.bottom).toBeGreaterThan(0.05);
    expect(whole.top - refused.top).toBeCloseTo(whole.bottom - refused.bottom, 9);
    expect(await page.evaluate(() => (window as any).redraws)).toBe(0);
    // Only the section changed, from the gizmo: no selection, no edit. sectiongizmochange also came with each change of
    // the chosen handles (each Esc and click, the values set, attaching afresh), and the value had them by then.
    const events = await page.evaluate(() => (window as any).events as [string, unknown][]);
    const all = [0, 1, 2, 3, 4, 5];
    expect(events.slice(0, 2)).toEqual([['sectionchange', 'api'], ['sectiongizmochange', all]]);
    expect(events.filter(([type]) => type === 'sectiongizmochange').map(([, handles]) => handles)).toEqual([all, [], [0], [2, 5], null, [0], [], [5], [], [0], all]);
    expect(events.filter(([, source]) => source === 'gizmo').length).toBeGreaterThan(5);
    expect(events.slice(2).filter(([type, source]) => type !== 'sectiongizmochange' && (type !== 'sectionchange' || source !== 'gizmo'))).toEqual([]);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).dirty)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('the section gizmo stays out of screenshot(), works when readonly, goes with its entry and stays through tools', async ({ page }) => {
    const errors = await open(page, MOCK);
    const canvas = page.locator('usd-viewer canvas');
    const image = () => page.evaluate(async () => new Uint8Array(await (await (document.querySelector('usd-viewer') as UsdViewerElement).screenshot()).arrayBuffer()).join());
    const viewer = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { gizmo: v.sectionGizmo, plane: v.section.planes[0], dirty: v.dirty };
    });
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      v.setAttribute('readonly', '');
      v.section = { on: true, planes: [{ point: [0, 0, 40], normal: [-1, 0, 0] }], boxes: [] }; // its point far out of view
    });
    const without = await image();
    const view = await canvas.screenshot();
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).sectionGizmo = { plane: 0 }));
    expect(await image()).toBe(without);
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).idle());
    expect((await canvas.screenshot()).equals(view)).toBe(false); // the view itself shows it
    // Readonly: the plane still moves along its normal, the stage stays clean; Esc (no handles to clear) lets go. The
    // gizmo sits in the middle of the outline, where the stage's centre (the framed view's target) falls on the plane.
    const [, y, z] = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view.target);
    await dragAxis(page, [0, y, z], [-1, 0, 0]);
    const dragged = await viewer();
    expect(dragged.plane.point[0]).toBeLessThan(-0.2);
    expect(dragged.plane.normal).toEqual([-1, 0, 0]);
    expect(dragged.dirty).toBe(false);
    await canvas.focus();
    await page.keyboard.press('Escape');
    expect((await viewer()).gizmo).toBeNull();
    const result = await page.evaluate(async () => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      let changes = 0;
      v.addEventListener('sectiongizmochange', () => changes++);
      // Around the right-hand instance, off the stage origin.
      v.section = { ...v.section, boxes: [{ keep: 'outside', corners: [[1.5, 0, 1.5], [2.5, 0, 1.5], [2.5, 0, 2.5], [1.5, 0, 2.5]], bottom: -0.5, top: 0.5 }] };
      v.tool = 'navigate';
      v.sectionGizmo = { box: 0 }; // switches to Move, also when readonly
      const tool = v.tool;
      const rect = v.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const gizmoAt = (x: number, y: number, z: number) => {
        const p = v.three.camera.position.clone().set(x, y, z).project(v.three.camera);
        return v.sectionGizmoAt(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
      };
      // In place as soon as it is attached, before any frame: corner 0's top dot, and nothing at the stage origin.
      const early = [gizmoAt(1.5, 0.5, 1.5), gizmoAt(0, 0, 0)];
      await v.idle();
      const at = [gizmoAt(1.5, 0.5, 1.5), v.sectionGizmoAt(rect.left + 2, rect.bottom - 2)];
      v.tool = 'navigate';
      const navigating = v.sectionGizmo;
      v.sectionGizmo = { box: 0, rotate: true };
      const rotating = v.sectionGizmo;
      v.section = { ...v.section, boxes: [] }; // its entry goes
      return { tool, early, at, navigating, rotating, gone: v.sectionGizmo, changes };
    });
    // Navigate keeps the selection, like prims; rotate: true switches to Rotate (one change: the mode in the value).
    expect(result).toEqual({ tool: 'translate', early: [true, false], at: [true, false], navigating: { box: 0, rotate: false, handles: [0, 1, 2, 3, 4, 5] }, rotating: { box: 0, rotate: true }, gone: null, changes: 3 });
    expect(errors).toEqual([]);
  });

  test('a section gizmo drag in the warm-up of the first section, before any frame, goes as far as one after it, and the gizmo follows each change at once', async ({ page }) => {
    const errors = await open(page, MOCK);
    const [, y, z] = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view.target);
    /**
     * Plane 0 across X, its gizmo attached afresh, the plane moved 0.3 on along its normal by the host and its arrow
     * dragged from there: where the plane went, and frames drawn since.
     */
    const drag = async (settle: boolean) => {
      await page.evaluate(() => {
        const v = document.querySelector('usd-viewer') as UsdViewerElement;
        v.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
        v.sectionGizmo = { plane: 0 };
        v.section = { on: true, planes: [{ point: [-0.3, 0, 0], normal: [-1, 0, 0] }], boxes: [] };
        (window as any).drawn = 0;
      });
      await dragAxis(page, [-0.3, y, z], [-1, 0, 0], 60, { settle });
      return page.evaluate(() => [(document.querySelector('usd-viewer') as UsdViewerElement).section.planes[0].point[0], (window as any).drawn as number]);
    };
    // The page's first section warms up through scheduler.yield: held at its first yield, it lets no frame be drawn.
    await page.evaluate(() => {
      const w = window as any;
      (document.querySelector('usd-viewer') as UsdViewerElement).three.beforeRender.add(() => w.drawn++);
      const next = scheduler.yield.bind(scheduler);
      const gate = new Promise<void>((resolve) => (w.openGate = resolve));
      scheduler.yield = () => gate.then(next);
    });
    const [held, drawn] = await drag(false);
    // Still held: a click on corner 3's top dot chooses that corner alone, and the gizmo leaves the box's middle for the
    // corner's at once.
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      v.section = { on: true, planes: [], boxes: [{ keep: 'inside', corners: [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]], bottom: -1, top: 1 }] };
      v.sectionGizmo = { box: 0 };
    });
    const [dot, arrow, middle] = await toScreen(page, [[1, 1, -1], [1.3, 0, -1], [0, 0, 0]], false);
    await page.mouse.click(...dot);
    const chosen = await page.evaluate(([arrow, middle]) => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return [v.sectionGizmo, v.sectionGizmoAt(...arrow), v.sectionGizmoAt(...middle), (window as any).drawn];
    }, [arrow, middle]);
    // Still held: corner 0 alone, dragged along +X past corner 3, where the footprint would cross itself. The last steps
    // are refused, and as the drag ends the gizmo goes back to the corner, away from where the pointer let go.
    await page.evaluate(() => {
      addEventListener('pointerup', (e) => ((window as any).up = e));
      (document.querySelector('usd-viewer') as UsdViewerElement).sectionGizmo = { box: 0, handles: [0] };
    });
    await dragAxis(page, [-1, 0, -1], [1, 0, 0], 400, { settle: false });
    const x = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).section.boxes[0].corners[0][0]);
    const [corner] = await toScreen(page, [[x + 0.3, 0, -1]], false);
    const ended = await page.evaluate((corner) => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const { up, drawn } = window as any;
      return [v.sectionGizmoAt(...corner), v.sectionGizmoAt(up.clientX, up.clientY), drawn];
    }, corner);
    await page.evaluate(() => {
      (window as any).openGate();
      return (document.querySelector('usd-viewer') as UsdViewerElement).idle();
    });
    const [after] = await drag(true);
    // The view looks along X in part: pressed on a drag plane still facing the camera, the arrow would move it less;
    // pressed on the gizmo where the plane was before the host moved it, it would put the plane back near there.
    expect(drawn).toBe(0);
    expect(after).toBeLessThan(-0.5);
    expect(held).toBeCloseTo(after, 6);
    expect(chosen).toEqual([{ box: 0, rotate: false, handles: [3] }, true, false, 0]);
    expect([x > 0.5, x < 1]).toEqual([true, true]);
    expect(ended).toEqual([true, false, 0]);
    expect(errors).toEqual([]);
  });

  test('the Section menu adds planes and boxes; a right click flips, cuts out and deletes them, and Del deletes', async ({ page }) => {
    const errors = await open(page, MOCK);
    const state = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { section: v.section, gizmo: v.sectionGizmo, selection: v.selection };
    });
    const labels = async () => {
      await page.locator('usd-viewer .tools button', { hasText: 'Section' }).click();
      const items = await page.locator('usd-viewer .popup button').allTextContents();
      await page.keyboard.press('Escape');
      return items;
    };
    const menu = async (item: string) => {
      await page.locator('usd-viewer .tools button', { hasText: 'Section' }).click();
      await page.locator('usd-viewer .popup button', { hasText: item }).click();
    };
    /** Right click at a world point, then the item of the menu that opens. */
    const right = async (point: number[], item: string) => {
      await page.mouse.click(...(await toScreen(page, [point]))[0], { button: 'right' });
      const items = await page.locator('usd-viewer .popup button').allTextContents();
      await page.locator('usd-viewer .popup button', { hasText: item }).click();
      return items;
    };
    await page.evaluate(() => {
      const events: string[] = ((window as any).events = []);
      document.querySelector('usd-viewer')!.addEventListener('sectionchange', (e) => events.push((e as CustomEvent).detail.source));
    });
    // A plane across X through the stage's centre, keeping the -X side, selected at once; the tool stays Select.
    await menu('Plane X');
    let { section, gizmo, selection } = await state();
    expect(section.planes.map((p) => p.normal)).toEqual([[-1, 0, 0]]);
    expect(gizmo).toEqual({ plane: 0, rotate: false });
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).tool)).toBe('select');
    // A box around the selected cube (a 1 % margin), selected instead of the cube: never both.
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).select('/World/Cube'));
    expect(await labels()).toEqual(['Plane X', 'Plane Y (horizontal)', 'Plane Z', 'Plane facing the view', 'Box around the selection', 'Hide handles', 'Sections off', 'Clear', 'Select all', 'Flip plane', 'Cut out', 'Delete selected']);
    await menu('Box around the selection');
    ({ section, gizmo, selection } = await state());
    const m = 0.5 + Math.sqrt(3) / 100;
    expect([gizmo, selection]).toEqual([{ box: 0, rotate: false, handles: [0, 1, 2, 3, 4, 5] }, []]);
    expect(section.boxes[0].keep).toBe('inside');
    expect([section.boxes[0].bottom, section.boxes[0].top].map((h) => +h.toFixed(6))).toEqual([-m, m].map((h) => +h.toFixed(6)));
    // A right click on the plane's dot (the stage's centre: the view's target) selects it and offers Flip and Delete,
    // not the prim menu; one on the box's corner edge offers Cut out.
    const target = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view.target);
    expect(await right(target, 'Flip plane')).toEqual(['Flip plane', 'Delete']);
    expect(await right([-m, 0, -m], 'Cut out')).toEqual(['Cut out', 'Delete']);
    ({ section, gizmo } = await state());
    expect([section.planes[0].normal[0], section.boxes[0].keep, gizmo]).toEqual([1, 'outside', { box: 0, rotate: false, handles: [0, 1, 2, 3, 4, 5] }]);
    // Del deletes what is selected: a new plane; a right click deletes the box. Removing an earlier entry keeps the
    // selection on its own entry.
    await menu('Plane Y');
    expect((await state()).gizmo).toEqual({ plane: 1, rotate: false });
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Delete');
    expect(await right([-m, 0, -m], 'Delete')).toEqual(['Show inside', 'Delete']);
    ({ section, gizmo } = await state());
    expect([section.planes.map((p) => p.normal), section.boxes.length, gizmo]).toEqual([[[1, 0, 0]], 0, null]);
    await menu('Clear');
    expect(await state()).toEqual({ section: { on: true, planes: [], boxes: [] }, gizmo: null, selection: [] });
    expect(await page.evaluate(() => (window as any).events)).toEqual(Array(8).fill('ui'));
    // The Section menu edits the selection too: Esc lets go of a new plane, Select all takes it back, then Flip plane
    // and Delete selected.
    await menu('Plane X');
    await page.locator('usd-viewer canvas').focus();
    await page.keyboard.press('Escape');
    expect((await state()).gizmo).toBeNull();
    await menu('Select all');
    expect((await state()).gizmo).not.toBeNull();
    await menu('Flip plane');
    expect((await state()).section.planes.map((p) => p.normal)).toEqual([[1, 0, 0]]);
    await menu('Delete selected');
    expect((await state()).section.planes).toEqual([]);
    // 7 planes and 8 boxes: the menu stays in the window, its first item at hand.
    await page.evaluate(() => {
      const box: Section['boxes'][number] = { keep: 'inside', corners: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], bottom: -1, top: 1 };
      (document.querySelector('usd-viewer') as UsdViewerElement).section = { on: true, planes: Array(7).fill({ point: [0, 0, 0], normal: [0, 1, 0] }), boxes: Array(8).fill(box) };
    });
    await page.locator('usd-viewer .tools button', { hasText: 'Section' }).click();
    const popup = (await page.locator('usd-viewer .popup').boundingBox())!;
    expect([popup.y >= 0, popup.y + popup.height <= page.viewportSize()!.height]).toEqual([true, true]);
    await page.locator('usd-viewer .popup button', { hasText: 'Plane X' }).click();
    expect((await state()).section.planes).toHaveLength(8);
    expect(errors).toEqual([]);
  });

  test('the details panel edits the selected planes and boxes, refusing values that would not draw', async ({ page }) => {
    const errors = await open(page, MOCK);
    const section = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).section);
    const props = page.locator('usd-viewer .props');
    const set = async (label: string, value: string) => {
      await props.getByLabel(label, { exact: true }).fill(value);
      await props.getByLabel(label, { exact: true }).press('Enter');
    };
    await page.locator('usd-viewer .tools button', { hasText: 'Section' }).click();
    await page.locator('usd-viewer .popup button', { hasText: 'Plane X' }).click();
    await expect(props.locator('summary')).toHaveText(['Plane 1']);
    await set('Plane 1 point X', '0.25');
    expect((await section()).planes[0].point[0]).toBe(0.25);
    await set('Plane 1 normal X', '0'); // a zero normal would drop the plane: the value comes back
    await expect(props.getByLabel('Plane 1 normal X')).toHaveValue('-1');
    await props.getByRole('button', { name: 'Flip' }).click();
    expect((await section()).planes[0].normal).toEqual([1, 0, 0]);
    await expect(props.getByLabel('Plane 1 normal X')).toHaveValue('1');
    await props.getByRole('button', { name: 'Delete' }).click();
    expect((await section()).planes).toEqual([]);
    await expect(props.locator('.hint')).toBeVisible();
    // A box: Cut out, a new top, and a top below its bottom refused.
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      v.section = { on: true, planes: [], boxes: [{ keep: 'inside', corners: [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]], bottom: -0.5, top: 0.5 }] };
      v.sectionGizmo = { box: 0 };
    });
    await expect(props.locator('summary')).toHaveText(['Box 1']);
    await props.locator('select').selectOption('outside');
    await set('Box 1 top', '2');
    await set('Box 1 bottom', '3');
    await expect(props.getByLabel('Box 1 bottom')).toHaveValue('-0.5');
    expect((await section()).boxes.map((b) => [b.keep, b.bottom, b.top])).toEqual([['outside', -0.5, 2]]);
    // Selecting a prim shows the prim; the section stays.
    await page.locator('usd-viewer .row .name', { hasText: 'Cube' }).click();
    await expect(props.locator('.head strong')).toHaveText('Cube');
    expect(errors).toEqual([]);
  });

  test('planes and boxes follow the tools like prims: Select shows no gizmo, Move and Rotate do; readonly moves sections only', async ({ page }) => {
    const errors = await open(page, MOCK);
    const state = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { section: v.section, gizmo: v.sectionGizmo, selection: v.selection, tool: v.tool };
    });
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      v.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [{ keep: 'outside', corners: [[1.5, 0, 1.5], [2.5, 0, 1.5], [2.5, 0, 2.5], [1.5, 0, 2.5]], bottom: -0.5, top: 0.5 }] };
    });
    const target = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view.target);
    const [, y, z] = target;
    const [planeDot, cornerDot] = await toScreen(page, [[0, y, z], [1.5, 0.5, 1.5]]);
    /** Transform gizmos shown: the section's and the prims' TransformControls. */
    const gizmos = () => page.evaluate(async () => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      await v.idle();
      return v.three.scene.children.filter((o: any) => o.isTransformControlsRoot && o.visible).length;
    });
    // Select: a click chooses corner 0, and no gizmo shows; W shows one, and a drag moves the corner in plan.
    await page.mouse.click(...cornerDot);
    expect([(await state()).gizmo, await gizmos()]).toEqual([{ box: 0, rotate: false, handles: [0] }, 0]);
    await page.keyboard.press('w');
    expect(await gizmos()).toBe(1);
    await dragAxis(page, [1.5, 0, 1.5], [1, 0, 0]);
    const moved = (await state()).section.boxes[0].corners[0];
    expect(moved[0]).toBeGreaterThan(1.6);
    // E with the box and the plane: the ring about the up axis turns both about the middle of their centres, the
    // box's footprint as a whole and the plane's normal by the same angle; the box stays upright.
    await page.keyboard.down('Shift');
    await page.mouse.click(...planeDot);
    await page.keyboard.up('Shift');
    await page.keyboard.press('e');
    const before = await state();
    expect([before.tool, before.gizmo]).toEqual(['rotate', { planes: [0], boxes: [{ box: 0, handles: [0] }] }]);
    const box = before.section.boxes[0];
    const mean = [0, 2].map((i) => box.corners.reduce((sum, c) => sum + c[i], 0) / 4);
    const o = [mean[0] / 2, y / 2, (z + mean[1]) / 2]; // between the plane's dot (0, y, z) and the box's middle
    // A point on the up axis ring, in front of the gizmo: dragged sideways.
    const ring = await page.evaluate((o) => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const camera = v.three.camera as any;
      const centre = camera.position.clone().set(o[0], o[1], o[2]);
      const factor = (centre.distanceTo(camera.position) * Math.min((1.9 * Math.tan((Math.PI * camera.fov) / 360)) / camera.zoom, 7)) / 4;
      const toward = camera.position.clone().sub(centre).setY(0).normalize().multiplyScalar(factor * 0.5);
      return centre.add(toward).toArray();
    }, o);
    const [press] = await toScreen(page, [ring]);
    await page.mouse.move(...press);
    await page.mouse.down();
    for (let d = 5; d <= 60; d += 5) await page.mouse.move(press[0] + d, press[1]);
    await page.mouse.up();
    const after = (await state()).section;
    const angle = (v: number[]) => Math.atan2(v[2], v[0]);
    const turn = (a: number[], b: number[]) => Math.atan2(Math.sin(angle(b) - angle(a)), Math.cos(angle(b) - angle(a)));
    const normalTurn = turn(before.section.planes[0].normal, after.planes[0].normal);
    const edge = (b: typeof box) => [b.corners[1][0] - b.corners[0][0], 0, b.corners[1][2] - b.corners[0][2]];
    expect(Math.abs(normalTurn)).toBeGreaterThan(0.05);
    expect(turn(edge(box), edge(after.boxes[0]))).toBeCloseTo(normalTurn, 6);
    expect(after.planes[0].normal[1]).toBeCloseTo(0, 9);
    expect([after.boxes[0].bottom, after.boxes[0].top]).toEqual([-0.5, 0.5]);
    // A prim selected clears the sections; a click on a section clears the prims.
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).select('/World/Cube'));
    expect((await state()).gizmo).toBeNull();
    await page.keyboard.press('q');
    await page.mouse.click(...(await toScreen(page, [after.boxes[0].corners[0].map((c, i) => (i === 1 ? 0.5 : c))]))[0]);
    expect([(await state()).gizmo !== null, (await state()).selection]).toEqual([true, []]);
    // readonly: W puts no gizmo on a prim (the cube stays), but still moves a section.
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      v.setAttribute('readonly', '');
      v.tool = 'translate';
      v.select('/World/Cube');
    });
    const cube = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).three.objectsFor('/World/Cube')[0].matrix.elements[12]);
    const x = await cube();
    await dragAlongX(page, '/World/Cube');
    expect(await cube()).toBe(x);
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).sectionGizmo = { plane: 0 }));
    const { point, normal } = (await state()).section.planes[0];
    // The gizmo sits on the plane's dot: where the stage's centre falls on it.
    const along = normal.reduce((sum, n, i) => sum + n * (point[i] - target[i]), 0);
    await dragAxis(page, target.map((t, i) => t + normal[i] * along), normal);
    const shifted = (await state()).section.planes[0].point;
    expect(Math.abs(shifted.reduce((sum, p, i) => sum + (p - point[i]) * normal[i], 0))).toBeGreaterThan(0.1);
    expect((await state()).tool).toBe('translate');
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).dirty)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('every section entry shows its handles: a click selects, Shift adds, one drag moves all, Hide handles and Del', async ({ page }) => {
    const errors = await open(page, MOCK);
    const canvas = page.locator('usd-viewer canvas');
    const state = () => page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      return { section: v.section, gizmo: v.sectionGizmo };
    });
    const at = (point: [number, number]) => page.evaluate((point) => (document.querySelector('usd-viewer') as UsdViewerElement).sectionGizmoAt(...point), point);
    const menu = async (item: string) => {
      await page.locator('usd-viewer .tools button', { hasText: 'Section' }).click();
      await page.locator('usd-viewer .popup button', { hasText: item }).click();
    };
    // A plane across X through the origin and a box around the right-hand instance, set by the host: nothing selected.
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const events: unknown[] = ((window as any).events = []);
      v.addEventListener('sectionchange', (e) => events.push((e as CustomEvent).detail.source));
      v.section = { on: true, planes: [{ point: [0, 0, 0], normal: [-1, 0, 0] }], boxes: [{ keep: 'outside', corners: [[1.5, 0, 1.5], [2.5, 0, 1.5], [2.5, 0, 2.5], [1.5, 0, 2.5]], bottom: -0.5, top: 0.5 }] };
    });
    // The plane's dot is where the stage's centre (the framed view's target) falls on it.
    const [, y, z] = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).view.target);
    const [planeDot, cornerDot, edge] = await toScreen(page, [[0, y, z], [1.5, 0.5, 1.5], [2.5, 0.5, 2]]);
    const rect = (await canvas.boundingBox())!;
    const nothing: [number, number] = [rect.x + 4, rect.y + rect.height - 4];
    expect([await at(planeDot), await at(cornerDot), await at(edge), await at(nothing), (await state()).gizmo]).toEqual([true, true, true, false, null]);
    // A click on corner 0's top dot chooses that corner of the box; Shift+click on the plane's dot adds the plane.
    await page.mouse.click(...cornerDot);
    expect((await state()).gizmo).toEqual({ box: 0, rotate: false, handles: [0] });
    await page.keyboard.down('Shift');
    await page.mouse.click(...planeDot);
    await page.keyboard.up('Shift');
    expect((await state()).gizmo).toEqual({ planes: [0], boxes: [{ box: 0, handles: [0] }] });
    // W: the arrows sit between the plane's dot and the corner's middle; dragged along +X, both move by the same shift.
    await page.keyboard.press('w');
    await dragAxis(page, [0.75, y / 2, (z + 1.5) / 2], [1, 0, 0]);
    let { section } = await state();
    const shift = section.boxes[0].corners[0][0] - 1.5;
    expect(shift).toBeGreaterThan(0.1);
    expect(section.planes[0].point[0]).toBeCloseTo(shift, 6);
    expect([section.planes[0].normal, section.boxes[0].corners[0].slice(1), section.boxes[0].corners.slice(1)]).toEqual([[-1, 0, 0], [0, 1.5], [[1.5, 0, 2.5], [2.5, 0, 2.5], [2.5, 0, 1.5]]]);
    // A click on nothing selects none; a click on the box's outline selects the whole box.
    await page.mouse.click(...nothing);
    expect((await state()).gizmo).toBeNull();
    await page.mouse.click(...edge);
    expect((await state()).gizmo).toEqual({ box: 0, rotate: false, handles: [0, 1, 2, 3, 4, 5] });
    // Hide handles lets go of it and takes the outlines away from the pointer; Show brings them back, Sections off hides them.
    await menu('Hide handles');
    expect([(await state()).gizmo, await at(edge), await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).sectionHandles)]).toEqual([null, false, false]);
    await menu('Show handles');
    expect(await at(edge)).toBe(true);
    await menu('Sections off');
    expect(await at(edge)).toBe(false);
    await menu('Sections on');
    // The navigate tool looks around: no dot or outline takes the pointer there.
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).tool = 'navigate'));
    expect(await at(edge)).toBe(false);
    await page.evaluate(() => ((document.querySelector('usd-viewer') as UsdViewerElement).tool = 'select'));
    // Del deletes what is selected: the box, the plane stays.
    await page.mouse.click(...edge);
    await canvas.focus();
    await page.keyboard.press('Delete');
    ({ section } = await state());
    expect([section.planes.length, section.boxes.length, (await state()).gizmo]).toEqual([1, 0, null]);
    // The host's section, the drag's steps, then Sections off and on and Del.
    const events: string[] = await page.evaluate(() => (window as any).events);
    expect([events[0], events.filter((source) => source !== 'gizmo').slice(1), events.slice(1, -3).every((source) => source === 'gizmo')]).toEqual(['api', ['ui', 'ui', 'ui'], true]);
    expect(errors).toEqual([]);
  });

  test('a selection builds its highlight once and keeps it: no shader build or shadow redraw per selection, nothing left over', async ({ page }) => {
    const errors = await open(page, MOCK);
    const run = () => page.evaluate(async () => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const w = window as any;
      w.builds = w.shadows = 0;
      for (const paths of [['/World/Cube'], ['/World/Instances'], ['/World/Instances/1'], ['/World/Cube', '/World/Instances'], []]) {
        v.select(paths);
        await v.idle();
      }
      let objects = 0;
      v.three.scene.traverse(() => objects++);
      return { builds: w.builds, shadows: w.shadows, objects };
    });
    await page.evaluate(() => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const w = window as any;
      (v.three.renderer as any).debug.onNodeBuilderCreated = () => w.builds++;
      let sun: any = null;
      v.three.scene.traverse((o: any) => o.isDirectionalLight && o.castShadow && (sun = o));
      v.three.beforeRender.add(() => void (sun.shadow.needsUpdate && w.shadows++));
    });
    const first = await run();
    const again = await run();
    // The first round builds the highlights; selecting the same prims again, a part of an instancer included, builds
    // nothing, redraws no shadow map, and leaves as many objects in the scene.
    expect(first.shadows).toBe(0);
    expect(again).toEqual({ builds: 0, shadows: 0, objects: first.objects });
    // The core worker the page started before the bundle was taken over by the element.
    expect(await page.evaluate(() => 'usdCoreWorker' in window)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a single instance draws as a plain mesh at its instance matrix and picks as instance 0; none draws nothing', async ({ page }) => {
    const errors = await open(page, MOCK);
    const result = await page.evaluate(async () => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const cube = v.three.objectsFor('/World/Cube')[0] as any;
      const g = cube.geometry;
      const instance = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 0, 0, 1]); // at x -5, clear of the rest
      v.session.emit('delta', {
        meshes: [70, 71].map((rid) => ({ rid, path: rid === 70 ? '/World/One/Proto' : '/World/None/Proto', purpose: 'default', indices: new Uint32Array(g.index.array), positions: new Float32Array(g.attributes.position.array), normals: new Float32Array(g.attributes.normal.array), counts: { points: 8, faces: 6, edges: 12 }, displayColor: [0.9, 0.9, 0.2], subsets: null, material: 0, instances: rid === 70 ? instance : new Float32Array(0) })),
      } as any);
      await v.idle();
      v.frame();
      await v.idle();
      const one = v.three.objectsFor('/World/One/Proto')[0] as any;
      const position = one.getWorldPosition(one.position.clone()).toArray();
      const rect = v.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const p = one.position.clone().set(-5, 0, 0).project(v.three.camera);
      const pick = await v.pick(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
      const none = v.three.objectsFor('/World/None/Proto')[0] as any;
      return { instanced: !!one.isInstancedMesh, position, pick, none: [!!none.isInstancedMesh, none.count] };
    });
    expect(result.instanced).toBe(false);
    expect(result.none).toEqual([true, 0]); // a prototype no instance uses
    expect(result.position.map((x: number) => +x.toFixed(6))).toEqual([-5, 0, 0]);
    expect(result.pick?.instanceIndex).toBe(0); // the mock core answers any rid but the cube's as an instance of /World/Instances
    expect(errors).toEqual([]);
  });

  test('small static meshes of one look draw in one batch, looking as drawn one by one', async ({ page }) => {
    const errors = await open(page, MOCK);
    const rids = Array.from({ length: 80 }, (_, i) => 100 + i);
    // 80 copies of the cube's streams in a grid below the stage; with positionsOnly, a points update for each.
    const inject = (positionsOnly: boolean) =>
      page.evaluate(async ({ rids, positionsOnly }) => {
        const v = document.querySelector('usd-viewer') as UsdViewerElement;
        const g = (v.three.objectsFor('/World/Cube')[0] as any).geometry;
        const positions = () => new Float32Array(g.attributes.position.array);
        const scale = (i: number) => [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, (i % 10) * 0.8 - 3.6, -1.5 - Math.floor(i / 10) * 0.4, -2, 1];
        v.session.emit('delta', positionsOnly ? { meshes: rids.map((rid) => ({ rid, positions: positions() })) } : {
          meshes: rids.map((rid) => ({
            rid, path: `/World/Many/C${rid}`, purpose: 'default', indices: new Uint32Array(g.index.array), positions: positions(),
            normals: new Float32Array(g.attributes.normal.array), counts: { points: 8, faces: 6, edges: 12 },
            displayColor: [0.2 + (rid % 5) * 0.15, 0.6, 0.3], subsets: null, material: 0, instances: null,
          })),
          xforms: { rids: new Uint32Array(rids), matrices: new Float64Array(rids.flatMap((_, i) => scale(i))) },
        } as any);
        v.frame();
        await v.idle();
        await new Promise((resolve) => setTimeout(resolve, 300)); // the full-detail frame after the view moved
        await v.idle();
        return v.three.root.children.filter((o: any) => o.isBatch).map((o: any) => o.instanceCount);
      }, { rids, positionsOnly });
    expect(await inject(false)).toEqual([80]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched.png', shot(page));
    // A batched item picks through its own object, and its stage visibility reaches its instance.
    const batched = await page.evaluate(async () => {
      const v = document.querySelector('usd-viewer') as UsdViewerElement;
      const vp = (v as any).viewport;
      const object = v.three.objectsFor('/World/Many/C105')[0];
      const p = object.getWorldPosition(object.position.clone()).project(v.three.camera);
      const rect = v.shadowRoot!.querySelector('canvas')!.getBoundingClientRect();
      const hit = vp.pick(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
      v.session.emit('delta', { visibility: { rids: new Uint32Array([105]), visible: new Uint8Array([0]) } } as any);
      const item = vp.sync.items.get(105);
      const hidden = !item.batched.batch.mesh.getVisibleAt(item.batched.instance);
      v.session.emit('delta', { visibility: { rids: new Uint32Array([105]), visible: new Uint8Array([1]) } } as any);
      return { rid: hit?.rid, hidden, standIn: (object as any).material.visible };
    });
    expect(batched).toEqual({ rid: 105, hidden: true, standIn: false });
    // A selected batched item shows its highlight (its object is drawn again while the fill shows).
    const select = (rids: number[]) =>
      page.evaluate(async (rids) => {
        const v = document.querySelector('usd-viewer') as UsdViewerElement;
        v.session.emit('delta', { selected: rids.map((rid) => ({ rid })) } as any);
        await v.idle();
      }, rids);
    await select([105, 117]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-selected.png', shot(page));
    await select([]);
    // Points updates take each item out of its batch for good: the same pictures, drawn one by one.
    expect(await inject(true)).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched.png', shot(page));
    await select([105, 117]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-selected.png', shot(page));
    expect(errors).toEqual([]);
  });

  test('in the wire modes batches draw their items\' edges in one draw each, looking as drawn one by one', async ({ page }) => {
    const errors = await open(page, MOCK);
    const rids = Array.from({ length: 144 }, (_, i) => 300 + i);
    // 144 copies of the cube with its triangles' edges in a grid below the stage, the last 64 mirrored: two batches of
    // one look. With positionsOnly, a points update for each, which takes it out of its batch.
    const inject = (positionsOnly: boolean) =>
      page.evaluate(async ({ rids, positionsOnly }) => {
        const v = document.querySelector('usd-viewer') as UsdViewerElement;
        const g = (v.three.objectsFor('/World/Cube')[0] as any).geometry;
        const positions = () => new Float32Array(g.attributes.position.array);
        const index = g.index.array as Uint32Array;
        const edges = new Uint32Array([...index].flatMap((_, t) => (t % 3 ? [] : [index[t], index[t + 1], index[t + 1], index[t + 2], index[t + 2], index[t]])));
        const place = (i: number) => [i < 80 ? 0.4 : -0.4, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, 0, (i % 12) * 0.6 - 3.3, -1.4 - Math.floor(i / 12) * 0.3, -2, 1];
        v.session.emit('delta', positionsOnly ? { meshes: rids.map((rid) => ({ rid, positions: positions() })) } : {
          meshes: rids.map((rid) => ({
            rid, path: `/World/Wired/C${rid}`, purpose: 'default', indices: new Uint32Array(index), positions: positions(),
            normals: new Float32Array(g.attributes.normal.array), counts: { points: 8, faces: 6, edges: 12 }, edges: new Uint32Array(edges),
            displayColor: [0.3, 0.5 + (rid % 3) * 0.15, 0.8], subsets: null, material: 0, instances: null,
          })),
          xforms: { rids: new Uint32Array(rids), matrices: new Float64Array(rids.flatMap((_, i) => place(i))) },
        } as any);
        v.frame();
        await v.idle();
        await new Promise((resolve) => setTimeout(resolve, 300)); // the full-detail frame after the view moved
        await v.idle();
        const batches = v.three.root.children.filter((o: any) => o.isBatch) as any[];
        return {
          batches: batches.map((b) => b.instanceCount),
          oneLook: batches.every((b) => b.material === batches[0].material),
          lines: batches.map((b) => !!b.lines?.visible),
          ownLines: rids.filter((rid) => v.three.objectsFor(`/World/Wired/C${rid}`)[0].children.some((o: any) => o.isLineSegments)).length,
        };
      }, { rids, positionsOnly });
    const mode = (displayMode: DisplayMode) =>
      page.evaluate(async (displayMode) => {
        const v = document.querySelector('usd-viewer') as UsdViewerElement;
        v.displayMode = displayMode;
        await v.idle();
      }, displayMode);
    await mode('shaded-wire');
    expect(await inject(false)).toEqual({ batches: [80, 64], oneLook: true, lines: [true, true], ownLines: 0 });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-shaded-wire.png', shot(page));
    await mode('wire');
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-wire.png', shot(page));
    // Out of their batches, each item draws its own lines: the same pictures.
    expect(await inject(true)).toEqual({ batches: [], oneLook: true, lines: [], ownLines: 144 });
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-wire.png', shot(page));
    await mode('shaded-wire');
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('mock-batched-shaded-wire.png', shot(page));
    expect(errors).toEqual([]);
  });

  test('live link: a layer pushed to the relay replaces the open layer, and viewer edits are published back', async ({ page, request, baseURL }) => {
    await request.delete(`${baseURL}/live/layers`);
    await open(page, `${MOCK}&live=1`);
    await expect.poll(() => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).live.connected)).toBe(true);
    const put = await request.put(`${baseURL}/live/layers/mock.usda`, { data: '#usda 1.0\n# cube offset 5\n', headers: { 'content-type': 'text/usda', 'x-live-origin': 'test' } });
    expect(put.status()).toBe(204);
    const cubeX = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).three.objectsFor('/World/Cube')[0].matrix.elements[12]);
    await expect.poll(cubeX).toBeCloseTo(5, 1);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).dirty)).toBe(true);
    // An edit in the viewer reaches the relay under the layer's name, marked with the viewer's origin.
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.usd.setXform('/World/Cube', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]);
    });
    await expect.poll(async () => (await request.get(`${baseURL}/live/layers/mock.usda`)).text()).toBe('#usda 1.0\n# cube offset 2\n');
    const origin = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).live.id);
    expect((await (await request.get(`${baseURL}/live/layers`)).json())[0]).toMatchObject({ name: 'mock.usda', version: 2, origin });
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
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('showcase.png', shot(page));
  });

  test('live link: a pushed usda moves the sphere in place, and a viewer edit comes back as usda', async ({ page, request, baseURL }) => {
    await request.delete(`${baseURL}/live/layers`);
    await open(page, `${SHOWCASE}&live=1`);
    const sphereY = () => page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).three.objectsFor('/World/Shapes/Sphere')[0].matrix.elements[13]);
    expect(await sphereY()).toBeCloseTo(0.6, 3);
    // What a Python script would send: the same file with one value changed.
    const text = readFileSync(new URL('../public/samples/showcase.usda', import.meta.url), 'utf8');
    expect(text).toContain('double3 xformOp:translate = (-3, 0.6, 0)');
    const put = await request.put(`${baseURL}/live/layers/showcase.usda`, { data: text.replace('(-3, 0.6, 0)', '(-3, 3, 0)'), headers: { 'content-type': 'text/usda', 'x-live-origin': 'test' } });
    expect(put.status()).toBe(204);
    await expect.poll(sphereY).toBeCloseTo(3, 3);
    const state = await page.evaluate(() => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      return { dirty: viewer.dirty, changed: viewer.session.changeState('/World/Shapes/Sphere'), canUndo: viewer.session.commands.canUndo };
    });
    expect(state).toEqual({ dirty: true, changed: 'self', canUndo: false });
    // The viewer's edit is published as the layer's usda, under its file name.
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      await viewer.usd.setAttribute('/World/Shapes/Sphere', 'xformOp:translate', [-3, 4, 0]);
    });
    await expect.poll(async () => (await request.get(`${baseURL}/live/layers/showcase.usda`)).text()).toContain('xformOp:translate = (-3, 4, 0)');
    await request.delete(`${baseURL}/live/layers`);
  });

  test('the Colour sky shows the background colour in front of the stage dome', async ({ page }) => {
    await open(page, SHOWCASE);
    const backgrounds = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const has = () => !!viewer.three.scene.background;
      const stage = has(); // the showcase's textured dome light
      viewer.sky = 'colour';
      await new Promise((r) => setTimeout(r, 100));
      const colour = has();
      viewer.sky = null;
      await new Promise((r) => setTimeout(r, 100)); // the dome texture comes back from the cache
      return { stage, colour, back: has(), lit: !!viewer.three.scene.environment };
    });
    expect(backgrounds).toEqual({ stage: true, colour: false, back: true, lit: true });
  });

  test('a host lists the stage cameras, hears when they change, and setting the view leaves a stage camera', async ({ page }) => {
    await open(page, SHOWCASE);
    const listed = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      const c = viewer.cameras.find((x) => x.path === '/World/Camera')!;
      viewer.camera = c.path;
      await viewer.idle();
      viewer.view = { eye: [1, 2, 3], target: [0, 0, 0], fov: 40, projection: 'perspective', height: 1 };
      return { focal: +c.params.focalLength.toFixed(3), aperture: +c.params.verticalAperture.toFixed(3), at: c.matrix.slice(12, 15), camera: viewer.camera };
    });
    expect(listed).toEqual({ focal: 2.8, aperture: 2.4, at: [0, 2.5, 9], camera: null }); // Hydra's lens: 0.1 x the authored 28 / 24
    const changed = await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      let changes = 0;
      viewer.addEventListener('cameraschange', () => changes++);
      await viewer.open('samples/materialx.usda'); // no cameras: the showcase's camera goes away
      await viewer.idle();
      return { changes, cameras: viewer.cameras.length };
    });
    expect(changed.cameras).toBe(0);
    expect(changed.changes).toBeGreaterThan(0);
  });

  test('the camera menu lists stage cameras and looks through them', async ({ page }) => {
    await open(page, SHOWCASE);
    const cameras = page.locator('usd-viewer select[title="Camera"]');
    await expect(cameras.locator('option[value="/World/Camera"]')).toHaveCount(1);
    await cameras.selectOption('/World/Camera');
    const view = () =>
      page.evaluate(async () => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        await viewer.idle();
        return { path: viewer.camera, position: viewer.three.camera.position.toArray().map((v) => +v.toFixed(3)) };
      });
    expect(await view()).toEqual({ path: '/World/Camera', position: [0, 2.5, 9] });
    await cameras.selectOption('');
    expect((await view()).path).toBeNull();
    // Another file (without cameras) while looking through one: back to "Free camera" only.
    await cameras.selectOption('/World/Camera');
    await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).open('samples/materialx.usda'));
    expect((await view()).path).toBeNull();
    await expect(cameras.locator('option')).toHaveText(['Free camera']);
    await expect(cameras).toHaveValue('');
    const note = await page.evaluate(() =>
      [...document.querySelector('usd-viewer')!.shadowRoot!.querySelectorAll('span')].find((s) => s.textContent === 'Looking through a stage camera')!.hidden,
    );
    expect(note).toBe(true); // View ▸ Camera is unlocked again
  });

  test('MaterialX networks render through three.js', async ({ page }) => {
    const errors = await open(page, '/?forceWebGL=1&src=samples/materialx.usda');
    expect(errors).toEqual([]);
    await expect(page.locator('usd-viewer canvas')).toHaveScreenshot('materialx.png', shot(page));
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
    const count = (n: number, timeout?: number) =>
      page.waitForFunction((n) => (document.querySelector('usd-viewer') as any).three.objectsFor('/World/SubdivCube')[0]?.geometry?.index?.count === n, n, { timeout });
    await count(36); // override on at level 0
    // A slow runner can rebuild the panel after that, and a level typed into the old input is lost: type it again.
    await expect(async () => {
      await refinement.locator('input[type=number]').fill('3');
      await refinement.locator('input[type=number]').dispatchEvent('change');
      await count(2304, 5_000);
    }).toPass({ timeout: 40_000 });
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
    // Core startup plus the open take seconds; a slow CI machine outlasts the 5 s default.
    await expect(page.locator('#log')).toContainText('opened, up axis Y', { timeout: 30_000 });
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

/* ---------- a host without isolation headers (GitHub Pages): sw.js provides them ---------- */

test.describe('hosting', () => {
  const HOST = 'http://localhost:4174';

  /** A first visit in a fresh context: navigations of the main frame, and the paths the service worker answered. */
  async function visit(browser: import('@playwright/test').Browser, url: string) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
    const page = await context.newPage();
    const counts = { navigations: 0, fromWorker: [] as string[], all: [] as string[], errors: [] as string[] };
    page.on('framenavigated', (frame) => frame === page.mainFrame() && counts.navigations++);
    page.on('response', (response) => {
      counts.all.push(new URL(response.url()).pathname);
      if (response.fromServiceWorker()) counts.fromWorker.push(new URL(response.url()).pathname);
    });
    page.on('pageerror', (error) => counts.errors.push(error.message));
    await page.goto(url);
    await expect.poll(() => counts.navigations).toBe(2); // the reload once sw.js is active
    await page.waitForFunction(() => crossOriginIsolated);
    const ready = () =>
      page.evaluate(async () => {
        const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
        await viewer.ready;
        if (!viewer.hasAttribute('src')) return;
        if (!viewer.stage) await new Promise((resolve) => viewer.addEventListener('stageopen', resolve, { once: true }));
        await viewer.idle();
      });
    await ready();
    return { context, page, counts, ready };
  }

  test('sw.js isolates the page with one reload and answers only the page and the worker scripts', async ({ browser }) => {
    const { context, page, counts, ready } = await visit(browser, `${HOST}/?core=mock-core/&forceWebGL=1&src=mock.usda`);
    expect(await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).stats.meshes)).toBe(4); // the cube and three instances
    expect(page.workers().length).toBe(1);
    expect(counts.fromWorker.filter((path) => path !== '/' && !path.endsWith('/worker.js'))).toEqual([]);
    expect(counts.fromWorker).toContain('/');
    expect(counts.fromWorker).toContain('/mock-core/worker.js');
    // Later visits are isolated from the start: no second reload.
    await page.reload();
    await ready();
    expect(counts.navigations).toBe(3);
    expect(counts.errors).toEqual([]);
    await context.close();
  });

  test('the wasm core boots under sw.js; the wasm is not served by it', async ({ browser }) => {
    test.skip(!existsSync(new URL('../public/core/usdcore.wasm', import.meta.url)), 'usdcore.wasm has not been built');
    const { context, page, counts } = await visit(browser, `${HOST}/?forceWebGL=1`);
    const core = await page.evaluate(() => (document.querySelector('usd-viewer') as UsdViewerElement).session.ready);
    expect(core.usd).toMatch(/^\d+\.\d+/);
    expect(page.workers().length).toBe(1 + core.threads); // the core's threads need the isolation
    expect(counts.fromWorker).toContain('/core/worker.js');
    expect(counts.all).toContain('/core/usdcore.wasm'); // requests from inside the worker are seen too
    expect(counts.fromWorker.filter((path) => path.endsWith('.wasm'))).toEqual([]);
    expect(counts.errors).toEqual([]);
    await context.close();
  });
});
