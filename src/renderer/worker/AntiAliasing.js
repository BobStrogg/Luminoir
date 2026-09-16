import * as THREE from 'three';
import { PostProcessing } from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { fxaaSuppressedFor } from './qualityPolicy.js';

/**
 * Anti-aliasing plumbing.  Desktop renderers use the default
 * framebuffer's MSAA; the no-MSAA mobile/Tesla profiles get an FXAA
 * post-pass instead (PostProcessing + TSL `fxaa` on WebGPU, an
 * EffectComposer ShaderPass on legacy WebGL).  FXAA is suppressed
 * under high runtime pressure via `updatePressure`.
 */
export class AntiAliasing {
  _postProcessing = null;
  _effectComposer = null;
  _fxaaPass = null;
  _fxaaAvailable = false;
  _fxaaSuppressed = false;
  _msaaSamples = 1;
  _aaMode = 'None';
  _aaBufferSize = new THREE.Vector2();

  get mode() { return this._aaMode; }
  get msaaSamples() { return this._msaaSamples; }
  get suppressed() { return this._fxaaSuppressed; }
  get available() { return this._fxaaAvailable; }

  _measureMsaaSamples(renderer, usingWebGPU) {
    if (usingWebGPU) {
      return Math.max(1, Number(renderer?.samples) || 1);
    }
    const gl = typeof renderer?.getContext === 'function' ? renderer.getContext() : null;
    const attributes = typeof renderer?.getContextAttributes === 'function'
      ? renderer.getContextAttributes()
      : null;
    if (!attributes?.antialias || !gl?.getParameter) return 1;
    return Math.max(1, Number(gl.getParameter(gl.SAMPLES)) || 1);
  }

  /** Render one frame through the FXAA pass when active, else direct. */
  render(renderer, scene, camera) {
    if (this._fxaaAvailable && !this._fxaaSuppressed) {
      if (this._postProcessing) return this._postProcessing.render();
      if (this._effectComposer) return this._effectComposer.render();
    }
    return renderer.render(scene, camera);
  }

  resize(renderer, width, height) {
    if (!this._effectComposer) return;
    this._effectComposer.setPixelRatio(renderer.getPixelRatio());
    this._effectComposer.setSize(width, height);
    if (this._fxaaPass?.material?.uniforms?.resolution) {
      renderer.getDrawingBufferSize(this._aaBufferSize);
      this._fxaaPass.material.uniforms.resolution.value.set(
        1 / Math.max(1, this._aaBufferSize.x),
        1 / Math.max(1, this._aaBufferSize.y),
      );
    }
  }

  /** Resize the composer to the renderer's current size (used by
   *  QualityController.setShadowQuality after a DPR change). */
  resizeToRenderer(renderer) {
    if (!this._effectComposer) return;
    renderer.getSize(this._aaBufferSize);
    this.resize(renderer, this._aaBufferSize.x, this._aaBufferSize.y);
  }

  async setup(renderer, scene, camera, usingWebGPU, width, height) {
    this._msaaSamples = this._measureMsaaSamples(renderer, usingWebGPU);
    if (this._msaaSamples > 1) {
      this._aaMode = `${this._msaaSamples}x MSAA`;
      return;
    }

    try {
      if (usingWebGPU) {
        const scenePass = pass(scene, camera);
        const outputPass = renderOutput(scenePass, renderer.toneMapping, renderer.outputColorSpace);
        this._postProcessing = new PostProcessing(renderer);
        this._postProcessing.outputColorTransform = false;
        this._postProcessing.outputNode = fxaa(outputPass);
      } else {
        this._effectComposer = new EffectComposer(renderer);
        this._effectComposer.addPass(new RenderPass(scene, camera));
        this._effectComposer.addPass(new OutputPass());
        this._fxaaPass = new ShaderPass(FXAAShader);
        this._effectComposer.addPass(this._fxaaPass);
        this.resize(renderer, width, height);
      }
      this._fxaaAvailable = true;
      this._aaMode = 'FXAA';
    } catch (error) {
      this._postProcessing = null;
      if (this._effectComposer) this._effectComposer.dispose();
      this._effectComposer = null;
      this._fxaaPass = null;
      this._aaMode = 'None';
      console.warn('[Luminoir] FXAA setup failed; continuing without post-process AA:', error);
    }
  }

  updatePressure(pressure) {
    if (!this._fxaaAvailable) return;
    this._fxaaSuppressed = fxaaSuppressedFor(this._fxaaSuppressed, pressure);
  }

  dispose() {
    if (this._effectComposer) this._effectComposer.dispose();
    this._postProcessing = null;
    this._effectComposer = null;
    this._fxaaPass = null;
    this._fxaaAvailable = false;
    this._fxaaSuppressed = false;
    this._msaaSamples = 1;
    this._aaMode = 'None';
  }
}
