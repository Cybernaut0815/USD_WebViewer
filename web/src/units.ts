// Pure conversions from UsdLux / UsdGeomCamera quantities to three.js ones.
// No imports, so `node --test` can run this file directly.
import type { LightParams } from './protocol.ts';

/**
 * UsdLux defines intensity so that 1 nit renders as pixel value 1 at exposure 0,
 * and three's physical light units line up with that, so no hidden factor is
 * needed. This knob exists for calibrating against a reference renderer.
 */
export const LIGHT_CALIBRATION = 1;

const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** Luminance in nits before any size factor. */
export function luminance(p: Pick<LightParams, 'intensity' | 'exposure'>): number {
  return p.intensity * 2 ** p.exposure * LIGHT_CALIBRATION;
}

/** DistantLight -> DirectionalLight.intensity (irradiance on a facing surface). */
export function distantIrradiance(p: LightParams): number {
  const L = luminance(p);
  const half = Math.min(Math.max(rad(p.angle ?? 0.53) / 2, 0), Math.PI / 2);
  if (p.normalize || half === 0) return L;
  return L * Math.PI * Math.sin(half) ** 2;
}

/** SphereLight -> PointLight / SpotLight.intensity (candela). */
export function sphereCandela(p: LightParams, radius: number): number {
  const L = luminance(p);
  return p.normalize ? L / 4 : L * Math.PI * radius * radius;
}

/** RectLight -> RectAreaLight.intensity (nits). Width and height in world units. */
export function rectNits(p: LightParams, width: number, height: number): number {
  const L = luminance(p);
  return p.normalize ? L / (width * height) : L;
}

/** DiskLight -> equal-area square RectAreaLight: returns [side, nits]. */
export function diskAsRect(p: LightParams, radius: number): [number, number] {
  const L = luminance(p);
  return [radius * Math.sqrt(Math.PI), p.normalize ? L / (Math.PI * radius * radius) : L];
}

/** CylinderLight -> PointLight.intensity (candela), using its mean projected area. */
export function cylinderCandela(p: LightParams, radius: number, length: number): number {
  const L = luminance(p);
  return p.normalize ? L / 4 : (L * Math.PI * radius * length) / 2;
}

/** UsdGeomCamera -> vertical field of view in degrees. */
export function verticalFov(verticalAperture: number, focalLength: number): number {
  return (2 * Math.atan(verticalAperture / (2 * focalLength)) * 180) / Math.PI;
}
