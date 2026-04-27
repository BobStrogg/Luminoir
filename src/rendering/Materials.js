import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  add,
  clamp,
  float,
  length,
  materialEmissive,
  mul,
  sub,
  varyingProperty,
} from 'three/tsl';
import { SceneConfig } from './SceneConfig.js';

const c = (r, g, b) => new THREE.Color(r, g, b);

/**
 * Renderer-kind flag read by `Materials.noteHead()` to choose
 * between the TSL node-material path (WebGPU) and the legacy
 * shader-injection path (WebGL).  Set by `setRendererKind()`
 * during worker init, *before* the scene builder instantiates
 * any materials.
 *
 * We branch the material choice here rather than always using
 * `MeshStandardNodeMaterial` because:
 *
 * 1. `WebGPURenderer`'s WebGL2 fallback (`WebGLBackend`) packs
 *    `instanceMatrix` into a UBO capped at 16 KB — InstancedMeshes
 *    with > 256 instances fail their vertex-shader link with
 *    "Size of uniform block NodeBuffer_N … exceeds 16384".  Our
 *    staff-line / simple-stem buckets routinely hit 400+ on
 *    medium scores and 2000+ on Sylvia Suite, so the node-material
 *    backend is unusable on the WebGL fallback for this project.
 *
 * 2. The legacy `THREE.WebGLRenderer` can't render `NodeMaterial`
 *    at all, but it *does* handle `MeshStandardMaterial` with
 *    `onBeforeCompile` correctly on any instance count — so we
 *    use it for the WebGL path.
 *
 * 3. The WebGPU path still gets the clean `emissiveNode`-based
 *    implementation because `onBeforeCompile` is silently dropped
 *    by `WebGPURenderer`'s auto-conversion from
 *    `MeshStandardMaterial` to `MeshStandardNodeMaterial`.
 *
 * @type {'webgpu' | 'webgl'}
 */
let _rendererKind = 'webgl';
export function setRendererKind(kind) {
  _rendererKind = kind === 'webgpu' ? 'webgpu' : 'webgl';
}

/** Shared material catalogue — avoids creating duplicates per element */
export const Materials = {
  note: () =>
    new THREE.MeshStandardMaterial({
      color: c(SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b),
      // Now that the paper is a bright off-white, the note colour
      // alone gives high enough contrast without the emissive hack
      // we needed on the dark theme — a dark note on a white page
      // reads clearly even in regions the pooled light balls never
      // reach.  Keeping a tiny emissive floor (≈0.1 of noteColor)
      // just prevents the note from going fully black in deep
      // shadow where the directional lights cancel out.
      emissive: c(SceneConfig.noteColor.r, SceneConfig.noteColor.g, SceneConfig.noteColor.b),
      emissiveIntensity: 0.15,
      metalness: SceneConfig.noteMetalness,
      roughness: SceneConfig.noteRoughness,
      // Single-sided renders only the extrusion's front face.  The
      // back face of a notehead is sandwiched between the paper and
      // the top cap ~0.003 world units apart, so with
      // `side: DoubleSide` WebGL's non-linear depth buffer
      // z-fights between the two faces and ends up drawing parts
      // of the back face (whose normals point down into the paper,
      // so the lighting comes out black) through the front face.
      // Chrome WebGPU's depth buffer has enough precision that this
      // doesn't visibly matter, which is why the bug only shows up
      // on `.local` URLs where Chrome falls back to WebGL.
    }),

  /**
   * Notehead material.  Branches on the current renderer:
   *
   * - **WebGPU** → `MeshStandardNodeMaterial` with a TSL
   *   `emissiveNode` that reads `vInstanceColor` and adds a
   *   played-amount-gated HDR contribution to the material's
   *   default emissive.  This is the only path that works under
   *   `WebGPURenderer`, since it auto-converts
   *   `MeshStandardMaterial` → `MeshStandardNodeMaterial` and
   *   drops any `onBeforeCompile` hook during the conversion.
   *
   * - **WebGL** (legacy `THREE.WebGLRenderer`) →
   *   `MeshStandardMaterial` with an `onBeforeCompile` hook that
   *   injects the same played-amount-gated emissive contribution
   *   into the stock GLSL fragment shader, hooked onto the
   *   `<emissivemap_fragment>` include point.  The legacy renderer
   *   doesn't understand node materials at all and refuses to link
   *   them; the WebGL2 fallback inside `WebGPURenderer`
   *   (`WebGLBackend`) understands node materials but puts the
   *   instance matrix into a 16KB UBO that overflows on any
   *   InstancedMesh with > 256 instances, so the legacy GLSL
   *   path is the only one that reliably draws our multi-hundred-
   *   instance staff-line / stem buckets.
   *
   * In both paths the visual output is identical by design: the
   * diffuse base is `noteColor` (dark, matching every other
   * notation element) and the played-note glow lives entirely in
   * the emissive channel, gated by `length(vInstanceColor)` so
   * unplayed notes — whose instance colour is the default
   * `noteColor` — contribute zero and stay matte.
   */
  noteHead: () => {
    const glowStrength = SceneConfig.playedNote.glowStrength;
    const nc = SceneConfig.noteColor;
    const unplayedMagnitude = Math.sqrt(nc.r * nc.r + nc.g * nc.g + nc.b * nc.b);

    if (_rendererKind === 'webgpu') {
      const mat = new MeshStandardNodeMaterial({
        color: c(nc.r, nc.g, nc.b),
        emissive: c(nc.r, nc.g, nc.b),
        emissiveIntensity: 0.15,
        metalness: SceneConfig.noteMetalness,
        roughness: SceneConfig.noteRoughness,
      });
      const vInstanceColor = varyingProperty('vec3', 'vInstanceColor');
      const playedAmount = clamp(
        sub(sub(length(vInstanceColor), float(unplayedMagnitude)), float(0.02)),
        float(0),
        float(1),
      );
      const emissiveContribution = mul(mul(playedAmount, vInstanceColor), float(glowStrength));
      mat.emissiveNode = add(materialEmissive, emissiveContribution);
      return mat;
    }

    // WebGL path — legacy shader-string injection.
    const mat = new THREE.MeshStandardMaterial({
      color: c(nc.r, nc.g, nc.b),
      emissive: c(nc.r, nc.g, nc.b),
      emissiveIntensity: 0.15,
      metalness: SceneConfig.noteMetalness,
      roughness: SceneConfig.noteRoughness,
      // See the comment on `note()` above: single-sided to avoid
      // WebGL's depth-buffer z-fighting on thin extrusions.
    });
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        [
          '#include <emissivemap_fragment>',
          '#ifdef USE_INSTANCING_COLOR',
          '  // Played-note glow: `vColor` is `instanceColor` after the',
          '  // Three.js instancing multiplication — unplayed notes use',
          '  // `noteColor` so `length(vColor)` sits at the baseline;',
          '  // played notes are painted with a brighter staff colour',
          '  // so `length(vColor)` moves clearly past it.',
          `  float playedAmount = clamp(length(vColor) - ${unplayedMagnitude.toFixed(4)} - 0.02, 0.0, 1.0);`,
          `  totalEmissiveRadiance += playedAmount * vColor * ${glowStrength.toFixed(3)};`,
          '#endif',
        ].join('\n'),
      );
    };
    return mat;
  },

  staffLine: () =>
    new THREE.MeshStandardMaterial({
      color: c(SceneConfig.staffColor.r, SceneConfig.staffColor.g, SceneConfig.staffColor.b),
      metalness: 0.1,
      roughness: 0.7,
    }),

  barLine: () =>
    new THREE.MeshStandardMaterial({
      color: c(SceneConfig.barLineColor.r, SceneConfig.barLineColor.g, SceneConfig.barLineColor.b),
      metalness: 0.1,
      roughness: 0.7,
    }),

  paper: () => {
    const { normalMap } = _sharedPaperTextures();
    const mat = new THREE.MeshStandardMaterial({
      color: c(SceneConfig.paperColor.r, SceneConfig.paperColor.g, SceneConfig.paperColor.b),
      metalness: 0.0,
      roughness: 0.95,
      normalMap,
      // Subtle fibre perturbation, like real paper.  Lower values
      // give a "watercolour paper" feel; higher values approach an
      // "embossed paper" look with more pronounced grain — a normal
      // map only, no real displacement, because actual paper
      // **doesn't** have visible silhouette bumps.  All the texture
      // comes from the way the surface scatters incoming light, and
      // a normal map is exactly how to fake that without paying for
      // displaced vertices.
      //
      // 1.8 here is calibrated against the procedural noise's
      // built-in `strength = 2.8` gradient amplification (in
      // `_sharedPaperTextures`) and the new floor-rotation lighting
      // angle: with the key light hitting the paper from roughly
      // 40° off normal (instead of the 50° it used to be when the
      // paper was a vertical wall), the same micro-perturbations
      // produce noticeably less shading contrast, so we compensate
      // by scaling up the perturbation amplitude itself.  Lands
      // close to a moderate "embossed paper" preset visually.
      // Higher values (3.0+) read as canvas/burlap rather than
      // paper; lower values disappear into the cream colour.
      normalScale: new THREE.Vector2(1.8, 1.8),
    });
    return mat;
  },

  other: () =>
    new THREE.MeshStandardMaterial({
      color: c(0.2, 0.2, 0.24),
      metalness: 0.0,
      roughness: 0.7,
      // See the comment on `note()` — single-sided to avoid WebGL's
      // z-fighting on thin extrusions, and none of the non-note
      // glyphs (clefs, meter/key sigs, tuplet numbers) rely on
      // back-face visibility from any reasonable camera angle.
    }),

  lightBall: (color) =>
    new THREE.MeshStandardMaterial({
      color: c(color.r, color.g, color.b),
      emissive: c(color.r, color.g, color.b),
      // Halved again from 0.8 to dim the ball further against the
      // cream paper.  Note that `LightBallController._applyVisuals`
      // overwrites this every frame with a scale-and-pulse-modulated
      // value (≈0.175 at rest), so the constructor value only
      // matters for the very first frame before any update().
      emissiveIntensity: 0.4,
      metalness: 0.0,
      roughness: 0.3,
      transparent: true,
      opacity: 0.95,
    }),

  lightBallGlow: (color) =>
    new THREE.SpriteMaterial({
      map: createGlowTexture(color),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Keep the default perspective attenuation on so the halo
      // shrinks naturally as the camera pulls back (matches what a
      // 3D "glow around a ball" should look like).  The per-frame
      // glowMod in LightBallController compensates with a sub-linear
      // distance boost so wide-shot scores like Sylvia Suite still
      // show a visible halo on every staff without letting close-ups
      // become screen-filling.
      sizeAttenuation: true,
    }),
};

/** Procedural radial glow texture for light ball sprites.
 *
 *  Uses OffscreenCanvas so this module works in both the main thread
 *  and the render Web Worker (the DOM `<canvas>` element isn't
 *  available inside the worker).  All evergreen browsers Luminoir
 *  targets support OffscreenCanvas + 2D context.
 */
function createGlowTexture(color) {
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  // Texture max alpha is set high enough that wide-shot orchestral
  // views (camera distance ≈ 30 with 27+ staves in frame) produce a
  // halo that's clearly perceptible against the cream paper.
  // Close-up scenes (distance < 4) get the same texture, but
  // `LightBallController._applyVisuals` multiplies the sprite's
  // `material.opacity` by a distance-modulated `glowMod` that drops
  // below 1.0 at close range (≈0.5 at d=2) — so the halo stays
  // subtle when the ball is right under the camera and ramps up to
  // full strength for far balls.  Without this distance ramp,
  // choosing a single alpha forced the trade-off "either the halo
  // dominates close-up or it's invisible on Sylvia"; with it, both
  // regimes work.  These values were tuned at a fixed close-up
  // (Dream a Little Dream, d≈2) to match the previous "halved
  // again" subtle look (≈0.045/0.0125 final alpha after the ×0.5
  // close-up scale) while leaving wide-shot at full ≈0.18/0.05
  // alpha for clear visibility on every staff.
  gradient.addColorStop(0, `rgba(${(color.r * 255) | 0},${(color.g * 255) | 0},${(color.b * 255) | 0},0.18)`);
  gradient.addColorStop(0.3, `rgba(${(color.r * 255) | 0},${(color.g * 255) | 0},${(color.b * 255) | 0},0.05)`);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/*  Procedural paper textures                                          */
/* ------------------------------------------------------------------ */

/**
 * Procedurally generated tileable noise normal map used to give the
 * paper backdrop a hint of fibrous bumpiness.  Real paper is a flat
 * sheet — its visible "texture" is entirely a *shading* effect from
 * the way light scatters off the surface fibres, not actual 3D
 * relief.  A normal map captures this perfectly: encode a
 * per-texel perturbation of the surface normal in tangent space
 * (RGB ≈ XYZ in -1..+1, packed to 0..255), and the lit material
 * computes shading as if the surface were micro-bumpy without
 * touching geometry at all.
 *
 * Two octaves at different spatial frequencies give the pattern a
 * fibre-like density that holds up both up close and when the camera
 * pulls back — a single octave looks smooth/blotchy on wide shots,
 * a single high-frequency octave looks noisy/sandy on close-ups.
 *
 * Cached in a module-level singleton: every instance of the paper
 * material shares the same GPU texture.
 */
let _paperTextures = null;
function _sharedPaperTextures() {
  if (_paperTextures) return _paperTextures;

  // Double the resolution of the previous 256-px map so the fine
  // grain survives a 2× viewport zoom without visibly tiling.  The
  // computation is a one-shot at build time, so the extra ms is
  // unnoticeable.
  const size = 512;
  const normalCanvas = new OffscreenCanvas(size, size);
  const normalCtx = normalCanvas.getContext('2d');
  const normalImg = normalCtx.createImageData(size, size);

  // Seeded pseudo-random so successive builds are deterministic.
  let seed = 0x9e3779b1 >>> 0;
  const rand = () => {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    return (seed >>> 0) / 4294967295;
  };

  // Two-octave tileable value-noise sum.  Low-frequency grid gives
  // the big "soft" fibre clumps; high-frequency grid adds fine grain
  // so the paper looks close to a real sheet at any zoom.  Both grids
  // wrap at their own period which is a divisor of `size`, so the
  // resulting texture tiles seamlessly.
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  /**
   * Build a `gridSize × gridSize` value-noise grid whose values are
   * smoothly interpolated to an `size × size` height field.
   */
  const valueNoise = (gridSize) => {
    const grid = new Float32Array((gridSize + 1) * (gridSize + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    // Make the edges match so the tile is seamless at its period.
    for (let i = 0; i <= gridSize; i++) {
      grid[i] = grid[gridSize * (gridSize + 1) + i];
      grid[i * (gridSize + 1) + gridSize] = grid[i * (gridSize + 1)];
    }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = x * gridSize / size;
        const gy = y * gridSize / size;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = smooth(gx - ix);
        const fy = smooth(gy - iy);
        const g00 = grid[iy * (gridSize + 1) + ix];
        const g10 = grid[iy * (gridSize + 1) + ix + 1];
        const g01 = grid[(iy + 1) * (gridSize + 1) + ix];
        const g11 = grid[(iy + 1) * (gridSize + 1) + ix + 1];
        const top = lerp(g00, g10, fx);
        const bot = lerp(g01, g11, fx);
        out[y * size + x] = lerp(top, bot, fy);
      }
    }
    return out;
  };

  const low = valueNoise(48);
  const high = valueNoise(128);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) {
    // 60 % low-frequency clumps + 40 % high-frequency fibres,
    // with a sprinkle of white noise for the very finest "pepper"
    // so close-ups have sub-pixel speckle.
    height[i] = low[i] * 0.6 + high[i] * 0.4 + (rand() - 0.5) * 0.08;
  }

  // Finite-difference gradient → tangent-space normal.  The small
  // `strength` keeps the bumps subtle; the caller controls overall
  // intensity via `normalScale`.
  const strength = 2.8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = (height[y * size + xp] - height[y * size + xm]) * strength;
      const dy = (height[yp * size + x] - height[ym * size + x]) * strength;
      // Invert dx,dy so flat = (0, 0, 1) in tangent space.
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      const i = (y * size + x) * 4;
      normalImg.data[i]     = Math.round((nx * inv * 0.5 + 0.5) * 255);
      normalImg.data[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      normalImg.data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      normalImg.data[i + 3] = 255;
    }
  }
  normalCtx.putImageData(normalImg, 0, 0);

  // Normal-map RGB values are direction vectors, NOT colours: they
  // must be sampled verbatim (no gamma decode).  Three.js defaults
  // `CanvasTexture` to `SRGBColorSpace`, which makes the renderer
  // gamma-decode samples on read — so a stored "flat" value of 0.5
  // ends up as 0.215 after decode, giving every pixel a strongly
  // tilted normal.  In practice the surface ends up looking smooth
  // because the tilt is *uniform* (every pixel gets the same offset
  // before perturbation), so the procedural fibres get drowned out
  // by the constant offset and the paper reads as featureless.
  // Setting `colorSpace = NoColorSpace` skips the decode and the
  // procedural fibres show up as intended.
  const normalTex = new THREE.CanvasTexture(normalCanvas);
  normalTex.colorSpace = THREE.NoColorSpace;
  normalTex.wrapS = normalTex.wrapT = THREE.RepeatWrapping;
  normalTex.repeat.set(8, 8);
  normalTex.needsUpdate = true;

  _paperTextures = { normalMap: normalTex };
  return _paperTextures;
}
