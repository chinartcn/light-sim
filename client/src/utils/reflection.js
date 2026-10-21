import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export class ReflectionProbe {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.mode = 'none'; // 'none' | 'probe' | 'hdr'
    
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(256, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(0.1, 100, this.cubeRenderTarget);
    this.pmremGenerator = new THREE.PMREMGenerator(renderer);
    this.pmremGenerator.compileCubemapShader();
    this.envMap = null;
    this.hdrTexture = null;
  }

  // 开启 Probe 模式
  enableProbe() {
    this.mode = 'probe';
    this.scene.background = new THREE.Color(0x111122); // 恢复纯色背景
    this.updateProbe();
  }

  updateProbe() {
    if (this.mode !== 'probe') return;

    this.cubeCamera.position.set(0, 2, 0);
    this.cubeCamera.visible = false;
    this.cubeCamera.update(this.renderer, this.scene);

    if (this.envMap) this.envMap.dispose();
    this.envMap = this.pmremGenerator.fromCubemap(this.cubeRenderTarget.texture).texture;
    this.scene.environment = this.envMap;
  }

  // 开启 HDR 模式
  loadHDR(url) {
    return new Promise((resolve, reject) => {
      if (this.mode === 'hdr') return resolve();
      
      const loader = new RGBELoader();
      loader.load(url, (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        
        if (this.envMap) this.envMap.dispose();
        this.envMap = this.pmremGenerator.fromEquirectangular(texture).texture;
        this.hdrTexture = texture;
        
        this.scene.environment = this.envMap;
        this.scene.background = texture; 
        this.scene.backgroundIntensity = 0.5;
        this.scene.environmentIntensity = 2.0; // 增强 HDR 反射亮度 
        
        this.mode = 'hdr';
        resolve();
      }, undefined, reject);
    });
  }

  // 关闭一切环境反射
  disable() {
    this.mode = 'none';
    this.scene.environment = null;
    this.scene.background = new THREE.Color(0x111122);
  }
}
