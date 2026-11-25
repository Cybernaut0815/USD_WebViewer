import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three/webgpu';
import { TextureCache } from '../src/materials.ts';

const cache = () => new TextureCache({ readBytes: async () => null, warn() {} });

/** A texture of three's MaterialX loader: its own object around a decoded image the cache handed out. */
function view(image: object, wrap: THREE.Wrapping = THREE.RepeatWrapping): THREE.Texture {
  const texture = new THREE.Texture(image);
  texture.wrapS = texture.wrapT = wrap;
  texture.flipY = false;
  return texture;
}

test('looks share one texture per image and sampler: three uploads every texture object on its own', () => {
  const textures = cache();
  const image = { width: 2, height: 2 };
  const first = view(image);
  assert.equal(textures.share(first), first);
  assert.equal(textures.share(view(image)), first, 'another look reading the same image');
  assert.notEqual(textures.share(view(image, THREE.ClampToEdgeWrapping)), first, 'another wrap mode samples it differently');
  assert.notEqual(textures.share(view({ width: 2, height: 2 })), first, 'another image');
  const empty = new THREE.Texture();
  assert.equal(textures.share(empty), empty, 'nothing to share before an image arrives');
});

test('closing the stage frees the shared textures; the next stage shares anew', () => {
  const textures = cache();
  const image = { width: 2, height: 2 };
  const first = textures.share(view(image));
  const clamped = textures.share(view(image, THREE.ClampToEdgeWrapping));
  let disposed = 0;
  for (const texture of [first, clamped]) texture.addEventListener('dispose', () => disposed++);
  textures.dispose();
  assert.equal(disposed, 2);
  const next = view(image);
  assert.equal(textures.share(next), next, 'not the disposed one');
});
