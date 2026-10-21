import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/**
 * 反射探针 —— per-room 版本。
 *
 * 原版把 cubemap 挂到 `scene.environment`，那是**全局**的：
 * 卧室的墙会反射出客厅的环境色，多房间必串色。
 *
 * 现在改成 per-material `material.envMap`：
 *   房间壳体材质 → 自己房间的 cubemap
 *   可替换物体   → 自己槽位房间的 cubemap
 * `scene.environment` 只留作兜底（给没指定 envMap 的物体）。
 *
 * 性能上，PMREM 是重活 —— 每个房间烘一次存下来，运行时只做一次
 * 低分辨率 cube render（只渲该房间的 layer）。
 */
export class ReflectionProbe {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.mode = 'none'; // 'none' | 'probe' | 'hdr'

    /** @type {Map<number, THREE.Texture>} roomId -> PMREM 后的 envMap */
    this.roomEnvs = new Map();
    /** @type {Map<string, THREE.Texture>} url -> PMREM 后的 HDR */
    this.hdrCache = new Map();

    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeRenderTarget);
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    this.pmremGenerator.compileCubemapShader();

    this.envMap = null;
    this.hdrTexture = null;
    this.resolution = 256;
  }

  /**
   * 为某个房间烘一张环境贴图。
   * @param {number} roomId
   * @param {THREE.Vector3} position 采样点（一般是房间中心）
   * @param {number} layerId 该房间占用的 layer（用来只渲这个房间）
   */
  captureRoom(roomId, position, layerId) {
    const size = this.resolution;
    this.cubeRenderTarget.setSize(size, size);

    this.cubeCamera.position.copy(position);
    this.cubeCamera.visible = false;
    // 只渲染该房间的 layer，避免把隔壁房间反射进来
    this.cubeCamera.layers.set(layerId);
    this.cubeCamera.update(this.renderer, this.scene);
    this.cubeCamera.layers.enableAll();

    const old = this.roomEnvs.get(roomId);
    if (old) old.dispose();

    const env = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture).texture;
    this.roomEnvs.set(roomId, env);
    return env;
  }

  /** 把某房间的环境贴图挂到材质上 */
  applyToMaterial(material, roomId) {
    const env = this.roomEnvs.get(roomId);
    if (!env || !material) return;
    material.envMap = env;
    material.needsUpdate = true;
  }

  /** 兜底：把当前房间的环境设为全局环境（给没指定 envMap 的物体） */
  setFallback(roomId) {
    const env = this.roomEnvs.get(roomId);
    this.envMap = env || null;
    this.scene.environment = this.envMap;
  }

  enableProbe() {
    this.mode = 'probe';
    this.scene.background = new THREE.Color(0x111122);
  }

  updateProbe(position, layerId) {
    if (this.mode !== 'probe') return;
    this.captureRoom(0, position, layerId);
    this.setFallback(0);
  }

  /**
   * 加载 HDR 天空。PMREM 结果按 URL 缓存 —— 千万别每次 toggle 都重算。
   */
  async loadHDR(url) {
    if (this.mode === 'hdr') return;

    if (this.hdrCache.has(url)) {
      this.envMap = this.hdrCache.get(url);
      this.scene.environment = this.envMap;
      this.scene.background = this.hdrTexture;
      this.mode = 'hdr';
      return;
    }

    const loader = new RGBELoader();
    const tex = await loader.loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = this.pmremGenerator.fromEquirectangular(tex);
    this.hdrCache.set(url, pmrem.texture);
    this.hdrTexture = tex;
    this.envMap = pmrem.texture;
    this.scene.environment = this.envMap;
    this.scene.background = tex;
    this.scene.backgroundIntensity = 0.5;
    this.scene.environmentIntensity = 1.0;
    this.mode = 'hdr';
  }

  disable() {
    this.mode = 'none';
    this.scene.environment = null;
    this.scene.background = new THREE.Color(0x111122);
  }

  dispose() {
    for (const env of this.roomEnvs.values()) env.dispose();
    this.roomEnvs.clear();
    for (const t of this.hdrCache.values()) t.dispose();
    this.hdrCache.clear();
    this.cubeRenderTarget.dispose();
    this.pmremGenerator.dispose();
  }
}
