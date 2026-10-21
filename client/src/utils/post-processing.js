import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * 分档后期管线。
 *
 * 关键点：**开关一个都不砍**，但档位决定"算多细 / 绕不绕开"。
 *
 * SSAOPass 内部会 renderOverride() 多渲一遍全场景取法线+深度，
 * 是整条管线里最贵的一步。做法是让它在**半分辨率**下工作
 * （内部 RT 尺寸缩小），最后由 composer 放大回画布 —— 视觉上几乎无损，
 * 填充率开销减半。
 */
class ScaledSSAOPass extends SSAOPass {
  constructor(scene, camera, width, height, scale = 1) {
    super(scene, camera, width, height);
    this.scale = scale;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    super.setSize(w, h);
  }
}

export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.composer = new EffectComposer(renderer);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.ssaoPass = new ScaledSSAOPass(
      scene,
      camera,
      window.innerWidth,
      window.innerHeight,
      1
    );
    this.ssaoPass.kernelRadius = 0.8;
    this.ssaoPass.minDistance = 0.005;
    this.ssaoPass.maxDistance = 0.1;
    this.ssaoPass.enabled = false;
    this.composer.addPass(this.ssaoPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.useComposer = true;
    this._ssaoEnabled = false;
  }

  setSSAO(enabled) {
    this._ssaoEnabled = enabled;
    this.ssaoPass.enabled = enabled && this.useComposer;
  }

  /** 应用质量档 */
  applyTier(settings) {
    this.useComposer = settings.useComposer;
    this.ssaoPass.scale = settings.ssaoScale;
    this.ssaoPass.kernelRadius = settings.ssaoKernelRadius;
    this.ssaoPass.enabled = this._ssaoEnabled && this.useComposer;
    this.resize(window.innerWidth, window.innerHeight);
  }

  resize(w, h) {
    this.composer.setSize(w, h);
    // composer.setSize 会把 SSAOPass 的尺寸重置回全尺寸，这里再压一次
    this.ssaoPass.setSize(w, h);
  }

  render() {
    if (this.useComposer) {
      this.composer.render();
    } else {
      // 低配档：绕开 EffectComposer，少掉全屏 blit 的带宽开销
      this.renderer.render(this.scene, this.camera);
    }
  }
}
