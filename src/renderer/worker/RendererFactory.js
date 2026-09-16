import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';

/**
 * Dual-renderer: try `WebGPURenderer` first (for Chrome/Edge on
 * secure contexts), fall back to the legacy `THREE.WebGLRenderer`
 * everywhere else.  We deliberately do *not* use `WebGPURenderer`'s
 * built-in WebGL2 fallback (`forceWebGL: true` → `WebGLBackend`)
 * because `InstanceNode` in that backend packs `instanceMatrix`
 * into a UBO capped at GL_MAX_UNIFORM_BLOCK_SIZE = 16384 bytes —
 * which is only 256 matrices.  Any InstancedMesh with more than
 * 256 instances (our staff-line and simple-stem buckets can
 * easily hit 400+ on Dream a Little Dream, 2000+ on Sylvia Suite)
 * fails its vertex shader link with
 *   "Size of uniform block NodeBuffer_N in VERTEX shader exceeds…"
 * and the affected meshes disappear from the render.  The legacy
 * `WebGLRenderer` always uses instanced vertex attributes for
 * matrices so it has no such cap.
 *
 * `?renderer=webgl` forces the legacy fallback even on a
 * WebGPU-capable origin, useful for reproducing WebGL-specific
 * bugs from the same machine.
 *
 * @returns {{ renderer: any, usingWebGPU: boolean, error?: any }}
 *   `renderer` is null when the WebGL fallback also throws — the
 *   caller posts `renderer_error`.
 */
export async function createRenderer({ canvas, forceWebGL, antialias }) {
  let renderer = null;
  let usingWebGPU = false;
  if (!forceWebGL) {
    try {
      renderer = new WebGPURenderer({ canvas, antialias, powerPreference: 'high-performance' });
      await renderer.init();
      usingWebGPU = true;
    } catch {
      renderer = null;
    }
  }
  if (!renderer) {
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    } catch (e) {
      return { renderer: null, usingWebGPU: false, error: e };
    }
  }
  return { renderer, usingWebGPU };
}

/**
 * Apply tone mapping + sRGB output on every renderer path.  The
 * played-note material pushes its emissive into HDR territory
 * (≈3+ before tone-mapping) so a recognisable shape remains under
 * a self-luminous glow rather than clipping to a flat white blob;
 * ACES Filmic compresses that range smoothly back into 0..1 for
 * the displayable framebuffer.
 */
export function applyOutputSettings(renderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
}
