import { expect, type Page, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { UsdViewerElement } from '../src/viewer.ts';

const MOCK = '/?core=mock-core/&forceWebGL=1&src=mock.usda';

/** Goldens are of the 3D view; the stats overlay on top of it is checked as text. */
const shot = (page: Page) => ({ mask: [page.locator('usd-viewer .stats')] });

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
  const [center, alongX] = await page.evaluate(async (path) => {
    const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
    await viewer.idle(); // the gizmo sits on the selection and has been drawn
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
    await page.evaluate(async () => {
      const viewer = document.querySelector('usd-viewer') as UsdViewerElement;
      viewer.displayMode = 'plain-wire';
      await viewer.idle();
    });
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
    await page.keyboard.down('w');
    await page.waitForTimeout(300);
    await page.keyboard.up('w');
    const after = await camera();
    const ahead = after.position.reduce((sum, p, i) => sum + (p - before.position[i]) * before.forward[i], 0);
    expect(before.tool).toBe('navigate');
    expect(after.tool).toBe('navigate');
    expect(ahead).toBeGreaterThan(0.1);
    await page.keyboard.press('n');
    expect((await camera()).tool).toBe('select');
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
