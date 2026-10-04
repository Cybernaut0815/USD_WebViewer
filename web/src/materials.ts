// USD material descriptions -> three.js node materials, plus the texture cache
// and the few special-purpose materials (fallback, curves, points, highlight).
import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  float,
  instancedBufferAttribute,
  mat4,
  modelWorldMatrixInverse,
  normalMap,
  positionGeometry,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { AssetValue, Json, MaterialEntry, MaterialNetwork, MaterialNode } from './protocol.ts';

type Node = any; // TSL node objects; their static types add little here
type Vec = number[];

export interface MaterialHost {
  /** Bytes of a resolved asset path, or null when it cannot be read. */
  readBytes(resolvedPath: string): Promise<ArrayBuffer | Blob | null>;
  warn(message: string): void;
}

/* ---------- textures ---------- */

const MAX_TEXTURE_SIZE = 4096;
const extension = (path: string) => /\.([a-z0-9]+)\]?$/i.exec(path)?.[1].toLowerCase() ?? '';

export class TextureCache {
  private readonly cache = new Map<string, Promise<THREE.Texture | null>>();
  private readonly host: MaterialHost;
  constructor(host: MaterialHost) {
    this.host = host;
  }

  /** Decoded texture for a resolved path, shared per (path, colour space). */
  get(path: string, colorSpace: string): Promise<THREE.Texture | null> {
    const key = `${colorSpace}|${path}`;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = this.decode(path, colorSpace).catch((error) => {
        this.host.warn(`texture ${path}: ${error.message ?? error}`);
        return null;
      });
      this.cache.set(key, entry);
    }
    return entry;
  }

  dispose(): void {
    for (const entry of this.cache.values()) entry.then((t) => t?.dispose());
    this.cache.clear();
  }

  private async decode(path: string, colorSpace: string): Promise<THREE.Texture | null> {
    const bytes = await this.host.readBytes(path);
    if (!bytes) {
      this.host.warn(`texture not found: ${path}`);
      return null;
    }
    const ext = extension(path);
    if (ext === 'exr' || ext === 'hdr') {
      const buffer = bytes instanceof Blob ? await bytes.arrayBuffer() : bytes;
      const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
      const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
      const data = (ext === 'exr' ? new EXRLoader() : new HDRLoader()).parse(buffer) as any;
      const tex = new THREE.DataTexture(data.data, data.width, data.height, data.format, data.type);
      // EXR rows are stored bottom-up by the loader already; Radiance files are top-down.
      tex.flipY = ext === 'hdr';
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      return tex;
    }
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
    // USD's st origin is bottom-left; pre-flipping the bitmap keeps UVs untouched on both backends.
    let bitmap = await createImageBitmap(blob, {
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    if (Math.max(bitmap.width, bitmap.height) > MAX_TEXTURE_SIZE) {
      const scale = MAX_TEXTURE_SIZE / Math.max(bitmap.width, bitmap.height);
      const small = await createImageBitmap(bitmap, {
        resizeWidth: Math.round(bitmap.width * scale),
        resizeHeight: Math.round(bitmap.height * scale),
        resizeQuality: 'high',
      });
      bitmap.close();
      bitmap = small;
    }
    const tex = new THREE.Texture(bitmap);
    tex.flipY = false;
    tex.colorSpace = colorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }
}

/* ---------- UsdPreviewSurface ---------- */

const WRAP: Record<string, THREE.Wrapping> = {
  repeat: THREE.RepeatWrapping,
  mirror: THREE.MirroredRepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
};
const isAsset = (v: unknown): v is AssetValue => !!v && typeof v === 'object' && 'resolved' in (v as object);
const num = (v: Json | AssetValue | undefined, fallback: number) => (typeof v === 'number' ? v : fallback);
const vec = (v: Json | AssetValue | undefined, fallback: Vec) => (Array.isArray(v) ? (v as Vec) : fallback);
const COLOR_INPUTS = new Set(['diffuseColor', 'emissiveColor', 'specularColor']);

class PreviewBuilder {
  readsDisplayColor = false;
  private readonly net: MaterialNetwork;
  private readonly textures: TextureCache;
  private readonly host: MaterialHost;
  constructor(net: MaterialNetwork, textures: TextureCache, host: MaterialHost) {
    this.net = net;
    this.textures = textures;
    this.host = host;
  }

  /** Node feeding `input` of `node`, or null when the input is not connected. */
  async connected(node: MaterialNode, input: string): Promise<Node | null> {
    const link = node.inputs[input];
    const source = link && this.net.nodes[link.node];
    if (!source) return null;
    if (source.type === 'UsdUVTexture') return this.sample(source, link.output, COLOR_INPUTS.has(input));
    if (source.type.startsWith('UsdPrimvarReader')) return this.primvar(source);
    this.host.warn(`unsupported shader node ${source.type} on ${input}`);
    return null;
  }

  private primvar(reader: MaterialNode): Node {
    const name = String(reader.params.varname ?? 'st');
    const kind = reader.type.split('_')[1] ?? 'float2';
    if (kind === 'float2') return name === 'st' ? uv() : attribute(`pv_${name}`, 'vec2');
    if (name === 'displayColor') {
      this.readsDisplayColor = true; // the scene gives meshes without vertex colours a constant stream
      return attribute('color', 'vec3');
    }
    const type = { float: 'float', float3: 'vec3', float4: 'vec4', point: 'vec3', normal: 'vec3', vector: 'vec3' }[kind];
    return attribute(`pv_${name}`, type ?? 'vec3');
  }

  private async coords(node: MaterialNode): Promise<Node> {
    const link = node.inputs.st;
    const source = link && this.net.nodes[link.node];
    if (!source) return uv();
    if (source.type === 'UsdTransform2d') {
      const base = await this.coordsOf(source, 'in');
      const [sx, sy] = vec(source.params.scale, [1, 1]);
      const [tx, ty] = vec(source.params.translation, [0, 0]);
      const angle = (num(source.params.rotation, 0) * Math.PI) / 180;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const x = base.x.mul(sx);
      const y = base.y.mul(sy);
      // result = in * scale * rotate + translation (counter-clockwise rotation)
      return vec2(x.mul(c).sub(y.mul(s)).add(tx), x.mul(s).add(y.mul(c)).add(ty));
    }
    return this.primvar(source);
  }

  private async coordsOf(node: MaterialNode, input: string): Promise<Node> {
    const link = node.inputs[input];
    const source = link && this.net.nodes[link.node];
    return source ? this.primvar(source) : uv();
  }

  private async sample(node: MaterialNode, output: string, isColor: boolean): Promise<Node | null> {
    const fallback = vec(node.params.fallback, [0, 0, 0, 1]);
    const pick = (v: Node) => (output === 'rgb' ? v.rgb : v[output] ?? v.r);
    const file = node.params.file;
    if (!isAsset(file) || !file.resolved) {
      if (isAsset(file) && file.asset) this.host.warn(`texture not resolved: ${file.asset}`);
      return pick(vec4(...(fallback as [number, number, number, number])));
    }
    // ponytail: "auto" is decided by usage (colour inputs are sRGB), not by sniffing bit depth.
    const declared = String(node.params.sourceColorSpace ?? 'auto');
    const floaty = /\.(exr|hdr)\]?$/i.test(file.resolved);
    const srgb = declared === 'sRGB' || (declared === 'auto' && isColor && output === 'rgb' && !floaty);
    const tex = await this.textures.get(file.resolved, srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    if (!tex) return pick(vec4(...(fallback as [number, number, number, number])));
    // Wrap modes are per texture object; "black" and "useMetadata" fall back to clamp.
    tex.wrapS = WRAP[String(node.params.wrapS ?? 'useMetadata')] ?? THREE.ClampToEdgeWrapping;
    tex.wrapT = WRAP[String(node.params.wrapT ?? 'useMetadata')] ?? THREE.ClampToEdgeWrapping;
    let value: Node = texture(tex, await this.coords(node));
    const scale = vec(node.params.scale, [1, 1, 1, 1]);
    const bias = vec(node.params.bias, [0, 0, 0, 0]);
    if (scale.some((v) => v !== 1)) value = value.mul(vec4(...(scale as [number, number, number, number])));
    if (bias.some((v) => v !== 0)) value = value.add(vec4(...(bias as [number, number, number, number])));
    return pick(value);
  }
}

async function buildPreviewSurface(
  net: MaterialNetwork,
  textures: TextureCache,
  host: MaterialHost,
): Promise<THREE.Material | null> {
  const surface = net.nodes[net.surface];
  if (!surface || surface.type !== 'UsdPreviewSurface') return null;
  const b = new PreviewBuilder(net, textures, host);
  const p = surface.params;
  const m = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide });

  const diffuse = await b.connected(surface, 'diffuseColor');
  if (diffuse) m.colorNode = diffuse;
  else m.color.setRGB(...(vec(p.diffuseColor, [0.18, 0.18, 0.18]) as [number, number, number]));

  const emissive = await b.connected(surface, 'emissiveColor');
  if (emissive) m.emissiveNode = emissive;
  else m.emissive.setRGB(...(vec(p.emissiveColor, [0, 0, 0]) as [number, number, number]));

  const ior = num(p.ior, 1.5);
  m.ior = ior;
  if (num(p.useSpecularWorkflow, 0) === 1) {
    // three computes F0 = f0(ior) * specularColor, so divide the authored F0 by f0(ior).
    const f0 = Math.max(((ior - 1) / (ior + 1)) ** 2, 1e-4);
    m.metalness = 0;
    const specular = await b.connected(surface, 'specularColor');
    if (specular) m.specularColorNode = specular.div(f0);
    else m.specularColor.setRGB(...(vec(p.specularColor, [0, 0, 0]).map((v) => v / f0) as [number, number, number]));
  } else {
    const metallic = await b.connected(surface, 'metallic');
    if (metallic) m.metalnessNode = metallic;
    else m.metalness = num(p.metallic, 0);
  }

  const roughness = await b.connected(surface, 'roughness');
  if (roughness) m.roughnessNode = roughness;
  else m.roughness = num(p.roughness, 0.5);

  const clearcoat = await b.connected(surface, 'clearcoat');
  if (clearcoat) m.clearcoatNode = clearcoat;
  else m.clearcoat = num(p.clearcoat, 0);
  const clearcoatRoughness = await b.connected(surface, 'clearcoatRoughness');
  if (clearcoatRoughness) m.clearcoatRoughnessNode = clearcoatRoughness;
  else m.clearcoatRoughness = num(p.clearcoatRoughness, 0.01);

  const opacity = await b.connected(surface, 'opacity');
  const threshold = num(p.opacityThreshold, 0);
  if (opacity) m.opacityNode = opacity;
  else m.opacity = num(p.opacity, 1);
  if (threshold > 0) m.alphaTest = threshold;
  else if (opacity || m.opacity < 1) {
    // ponytail: opacityMode "transparent" (specular kept) renders like "presence".
    m.transparent = true;
    m.depthWrite = false;
  }

  const normal = await b.connected(surface, 'normal');
  // normalMap() decodes 0..1 samples itself; a (2, -1) scale/bias has already produced -1..1.
  if (normal) m.normalNode = normalMap(normal.mul(0.5).add(0.5));

  const occlusion = await b.connected(surface, 'occlusion');
  if (occlusion) m.aoNode = occlusion;
  // ponytail: displacement is ignored; add a positionNode offset when an asset needs it.
  m.userData.readsDisplayColor = b.readsDisplayColor;
  return m;
}

/* ---------- MaterialX ---------- */

const WHITE = new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);

async function buildMaterialX(xml: string, textures: TextureCache, host: MaterialHost): Promise<THREE.Material | null> {
  const { MaterialXLoader } = await import('three/addons/loaders/MaterialXLoader.js');
  const manager = new THREE.LoadingManager();
  // Every image the document references is served from the core's resolver. The
  // material is handed out only once they are in: three cannot draw a texture without an image.
  const loading: Promise<void>[] = [];
  manager.addHandler(/[\s\S]*/, {
    // three's MaterialX loader asks for image data and wraps it in its own texture.
    load(uri: string, onLoad: (image: unknown) => void) {
      loading.push(
        textures.get(uri, THREE.NoColorSpace).then((loaded) => onLoad(loaded ? loaded.image : WHITE)), // missing: white pixel
      );
    },
  } as any);
  // Our bitmaps are already flipped to USD's bottom-left origin, which is what the
  // loader calls 'top-left' data: it must not flip the coordinates again.
  const result = (new MaterialXLoader(manager) as any).parse(xml, { uvSpace: 'top-left', throwOnErrors: false });
  await Promise.all(loading);
  for (const issue of result.errors ?? []) host.warn(`MaterialX: ${issue.message ?? JSON.stringify(issue)}`);
  const material = Object.values(result.materials ?? {})[0] as THREE.Material | undefined;
  if (!material) return null;
  material.side = THREE.DoubleSide;
  return material;
}

/** Fallback chain: MaterialX, then UsdPreviewSurface, then null (display colour). */
export async function buildMaterial(
  entry: MaterialEntry,
  textures: TextureCache,
  host: MaterialHost,
): Promise<THREE.Material | null> {
  if (entry.mtlx) {
    try {
      const material = await buildMaterialX(entry.mtlx, textures, host);
      if (material) return material;
    } catch (error: any) {
      host.warn(`MaterialX ${entry.path}: ${error.message ?? error}`);
    }
  }
  if (entry.network) {
    try {
      const material = await buildPreviewSurface(entry.network, textures, host);
      if (material) return material;
      host.warn(`${entry.path}: unsupported surface ${entry.network.nodes[entry.network.surface]?.type}`);
    } catch (error: any) {
      host.warn(`material ${entry.path}: ${error.message ?? error}`);
    }
  }
  return null;
}

/* ---------- special-purpose materials ---------- */

/** Unbound geometry: displayColor / displayOpacity, optionally per vertex. */
export function displayMaterial(color: Vec, opacity: number, vertexColors: boolean): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0, side: THREE.DoubleSide, vertexColors });
  if (!vertexColors) m.color.setRGB(color[0], color[1], color[2]);
  if (opacity < 1) {
    m.opacity = opacity;
    m.transparent = true;
    m.depthWrite = false;
  }
  return m;
}

/**
 * Curves as camera-facing ribbons: two vertices per curve point, pushed apart
 * in the vertex stage by the per-point width.
 */
export function ribbonMaterial(color: Vec, vertexColors: boolean): THREE.Material {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide, vertexColors });
  if (!vertexColors) m.color.setRGB(color[0], color[1], color[2]);
  const tangent = attribute('curveTangent', 'vec3');
  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const side = tangent.cross(eye.sub(positionGeometry)).normalize();
  m.positionNode = positionGeometry.add(side.mul(attribute('side', 'float')).mul(attribute('width', 'float')).mul(0.5));
  m.normalNode = vec3(0, 0, 1); // view space: shade as facing the camera
  return m;
}

export function hairlineMaterial(color: Vec, vertexColors: boolean): THREE.Material {
  const m = new THREE.LineBasicNodeMaterial({ vertexColors });
  if (!vertexColors) m.color.setRGB(color[0], color[1], color[2]);
  return m;
}

/** Points as instanced camera-facing discs sized in world units. */
export function pointsMaterial(
  positions: THREE.InstancedBufferAttribute,
  widths: THREE.InstancedBufferAttribute | null,
  colors: THREE.InstancedBufferAttribute | null,
  color: Vec,
): THREE.Material {
  const m = new THREE.SpriteNodeMaterial({ sizeAttenuation: true });
  m.positionNode = instancedBufferAttribute(positions);
  m.scaleNode = widths ? instancedBufferAttribute(widths) : float(1);
  if (colors) m.colorNode = instancedBufferAttribute(colors) as any;
  else m.color.setRGB(color[0], color[1], color[2]);
  const d = uv().sub(0.5).length();
  m.opacityNode = d.lessThan(0.5).select(float(1), float(0));
  m.alphaTest = 0.5;
  return m;
}

/** "No materials" display mode: one grey material, single- and double-sided. */
export const PLAIN = {
  double: new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.6, metalness: 0, side: THREE.DoubleSide }),
  single: new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.6, metalness: 0, side: THREE.FrontSide }),
};

/** Edges of the authored faces over the surface, and alone against the dark background. */
export const LINE = new THREE.LineBasicNodeMaterial({ color: 0x1c1c1c });
export const LINE_ALONE = new THREE.LineBasicNodeMaterial({ color: 0xa8acb3 });
/** Selection edges in the selection-wire modes; the active prim is brighter. */
export const SELECTED_LINE = new THREE.LineBasicNodeMaterial({ color: 0xd01818 });
export const ACTIVE_LINE = new THREE.LineBasicNodeMaterial({ color: 0xff6a6a });
/** Wireframe mode: the surface is not drawn but stays pickable. */
export const HIDDEN = new THREE.MeshBasicNodeMaterial({ visible: false });

/** A copy of a line material that places instance i with the matrix at buffer[16i..16i+16] (draw with object.count = instances). */
export function instancedLines(base: THREE.LineBasicNodeMaterial, buffer: THREE.InstancedInterleavedBuffer): THREE.Material {
  const m = base.clone();
  const column = (offset: number): Node => instancedBufferAttribute(buffer as any, 'vec4', 16, offset);
  m.positionNode = mat4(column(0), column(4), column(8), column(12)).mul(vec4(positionGeometry, 1)).xyz;
  return m;
}

const highlight = (color: number, opacity: number) =>
  new THREE.MeshBasicNodeMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
/** Selected prims; the active one is brighter. */
export const HIGHLIGHT = highlight(0xffc400, 0.3);
export const ACTIVE = highlight(0xfff0a0, 0.5);
