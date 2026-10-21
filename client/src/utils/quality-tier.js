import * as THREE from 'three';

/**
 * 质量档 —— 让"完整渲染管线"和"低配设备"不再打架。
 *
 * 核心思路：管线一个开关都不砍，但**静态的东西不在运行时算**。
 * 开关在 = 有这个效果；效果从哪来（现场算 / 读烘焙结果）是另一回事。
 *
 * 档位只影响"运行时动态部分算多细"，不影响功能可用性。
 */

export const HIGH = 'high';
export const MID = 'mid';
export const LOW = 'low';

export const TIER_ORDER = { high: 0, mid: 1, low: 2 };

export const TIER_PRESETS = {
  [HIGH]: {
    label: '高',
    pixelRatio: 2,
    useComposer: true,
    ssaoScale: 1.0,
    ssaoKernelRadius: 0.8,
    shadowMapSize: 1024,
    shadowType: THREE.PCFSoftShadowMap,
    reflectionSize: 256,
    contactShadow: true,
  },
  [MID]: {
    label: '中',
    pixelRatio: 1.5,
    useComposer: true,
    ssaoScale: 0.5,
    ssaoKernelRadius: 0.6,
    shadowMapSize: 512,
    shadowType: THREE.PCFShadowMap,
    reflectionSize: 128,
    contactShadow: true,
  },
  [LOW]: {
    label: '低',
    pixelRatio: 1,
    useComposer: false,
    ssaoScale: 0.5,
    ssaoKernelRadius: 0.5,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
    reflectionSize: 64,
    contactShadow: true,
  },
};

/**
 * 粗略设备能力探测。三项投票，任一偏弱就降档。
 */
export function detectTier() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4; // Safari 上没有这个 API，退回 4
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const webgl2 = (() => {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch (e) {
      return false;
    }
  })();

  let score = 0;
  if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;
  if (mem >= 8) score += 2;
  else if (mem >= 4) score += 1;
  if (!webgl2) score -= 3;
  if (mobile) score -= 1;

  if (score >= 4) return HIGH;
  if (score >= 1) return MID;
  return LOW;
}

export class QualityTier {
  constructor(initial = detectTier()) {
    this.tier = initial;
    this.settings = { ...TIER_PRESETS[initial] };
    this.auto = true;
    this.listeners = [];
    this._fpsSamples = [];
    this._watching = false;
  }

  onChange(fn) {
    this.listeners.push(fn);
    return this;
  }

  _emit() {
    for (const fn of this.listeners) fn(this.tier, this.settings);
  }

  set(tier) {
    if (!TIER_PRESETS[tier] || tier === this.tier) return;
    this.tier = tier;
    this.settings = { ...TIER_PRESETS[tier] };
    this._emit();
  }

  /** 手动设置即退出自动档 */
  setManual(tier) {
    this.auto = false;
    this.set(tier);
  }

  setAuto() {
    this.auto = true;
    this.set(detectTier());
  }

  /**
   * 运行时看门狗：连续掉帧就降一档。
   * 只降不升，避免来回抖动。
   */
  watchFPS(renderer) {
    if (this._watching) return;
    this._watching = true;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 2000) {
        this._fpsSamples.push(1000 / dt);
        if (this._fpsSamples.length > 90) this._fpsSamples.shift();
      }
      if (this.auto && this._fpsSamples.length >= 90) {
        const avg = this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length;
        if (avg < 24 && this.tier === HIGH) this.set(MID);
        else if (avg < 16 && this.tier === MID) this.set(LOW);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** 把档位应用到 renderer */
  applyToRenderer(renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.pixelRatio));
    renderer.shadowMap.type = this.settings.shadowType;
  }

  describe() {
    return {
      tier: this.tier,
      label: this.settings.label,
      auto: this.auto,
      pixelRatio: this.settings.pixelRatio,
      composer: this.settings.useComposer,
      ssaoScale: this.settings.ssaoScale,
      shadow: `${this.settings.shadowMapSize} / ${this.settings.shadowType}`,
      reflection: this.settings.reflectionSize,
    };
  }
}
