import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LightParams } from '../src/protocol.ts';
import { cylinderCandela, diskAsRect, distantIrradiance, rectNits, sphereCandela, verticalFov } from '../src/units.ts';

const light = (over: Partial<LightParams>): LightParams => ({
  color: [1, 1, 1], intensity: 1, exposure: 0, normalize: false, diffuse: 1, specular: 1, shadow: true, ...over,
});
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} != ${expected}`);

test('distant light: UsdLux default sun is about 3.36 irradiance', () => {
  close(distantIrradiance(light({ intensity: 50000, angle: 0.53 })), 3.36);
  close(distantIrradiance(light({ intensity: 2, angle: 0.53, normalize: true })), 2);
  close(distantIrradiance(light({ intensity: 2, exposure: 1, normalize: true })), 4);
});

test('sphere light: candela from radius, or power-normalised', () => {
  close(sphereCandela(light({}), 0.5), Math.PI / 4);
  close(sphereCandela(light({ normalize: true }), 0.5), 0.25);
});

test('rect, disk and cylinder lights', () => {
  close(rectNits(light({ intensity: 6, normalize: true }), 2, 3), 1);
  close(rectNits(light({ intensity: 6 }), 2, 3), 6);
  const [side, nits] = diskAsRect(light({ normalize: true }), 1);
  close(side * side, Math.PI); // equal area
  close(nits, 1 / Math.PI);
  close(cylinderCandela(light({ normalize: true }), 1, 1), 0.25);
});

test('camera: 50 mm lens on a 24 mm gate', () => close(verticalFov(24, 50), 26.9915));
