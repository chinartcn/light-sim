import * as THREE from 'three';

/**
 * Per-material SH 探针注入。
 *
 * 为什么不能用 scene 级 LightProbe：
 * three.js 的 WebGLLights 把所有 LightProbe 的 9 个系数 **累加**进同一份
 * state.probe，最终只有一组 `uniform vec3 lightProbe[9]` 作用于全场景。
 * 场景级探针没有空间概念，客厅白 + 卧室红只会被加成一团中间色。
 *
 * 做法：绕开 scene 级探针，直接给材质注入一组 uRoomSH。
 * 注入点选在 lights_fragment_begin 之后：
 *   irradiance += shGetIrradianceAt(worldNormal, uRoomSH)
 * shGetIrradianceAt 定义在 lights_pars_begin 中且不在 USE_LIGHT_PROBES 守卫内，
 * 所以不挂任何 LightProbe 也能用它的数学。
 *
 * 注意：uniform 容器不能放在 material.userData 里 ——
 * Material.copy() 用 JSON.parse(JSON.stringify(userData)) 做深拷贝，
 * THREE.Vector3 会被拷成普通对象，.set() 直接失效。这里用 WeakMap。
 */

const PATCH_FLAG = '__roomProbePatched';
const CACHE_KEY = 'room-probe-v1';

/** material → uniforms 容器 */
const _binding = new WeakMap();

/**
 * 给一个材质打上"按房间取 SH"的补丁。
 * @param {THREE.Material} material
 * @param {{roomSHUniform:{value:THREE.Vector3[]}, roomSHIntensityUniform:{value:number}}} uniforms
 */
export function patchRoomProbe(material, uniforms) {
  if (!material) return material;

  const isNew = !material[PATCH_FLAG];
  _binding.set(material, uniforms);

  if (isNew) {
    material[PATCH_FLAG] = true;

    const prevOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      if (prevOnBeforeCompile) prevOnBeforeCompile.call(this, shader, renderer);

      // uniform 对象在编译期从 WeakMap 取，之后外部直接改 .value 即可
      const u = _binding.get(material);
      if (u) {
        shader.uniforms.uRoomSH = u.roomSHUniform;
        shader.uniforms.uRoomSHIntensity = u.roomSHIntensityUniform;
      }

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <lights_pars_begin>',
          `#include <lights_pars_begin>
          uniform vec3 uRoomSH[ 9 ];
          uniform float uRoomSHIntensity;`
        )
        .replace(
          '#include <lights_fragment_begin>',
          `#include <lights_fragment_begin>
          #if defined( RE_IndirectDiffuse )
            irradiance += shGetIrradianceAt(
              inverseTransformDirection( geometryNormal, viewMatrix ),
              uRoomSH
            ) * uRoomSHIntensity;
          #endif`
        );
    };

    // 让打过补丁的材质和没打补丁的材质不会共用同一个 program
    material.customProgramCacheKey = () => CACHE_KEY;
  }

  // 换了 uniform 容器 → 需要重编译才能生效
  material.needsUpdate = true;
  return material;
}

/**
 * 为一个宿主对象准备 uniform 容器。
 */
export function createProbeUniforms(intensity = 1) {
  return {
    roomSHUniform: {
      value: Array.from({ length: 9 }, () => new THREE.Vector3()),
    },
    roomSHIntensityUniform: { value: intensity },
  };
}

/**
 * 把 9 个 RGB 系数写进 uniform（27 个数：9 系数 × RGB）。
 */
export function writeSH(uniform, coeffs) {
  const dst = uniform.value;
  for (let i = 0; i < 9; i++) {
    const o = i * 3;
    dst[i].set(coeffs[o] || 0, coeffs[o + 1] || 0, coeffs[o + 2] || 0);
  }
}

/**
 * 克隆材质但不复用绑定关系。
 * Material.copy() 的 userData 是 JSON 深拷贝，会毁掉 Vector3，
 * 所以这里手动做浅拷贝。
 */
export function cloneMaterial(material) {
  const c = material.clone();
  c.userData = { ...material.userData };
  delete c[PATCH_FLAG];
  return c;
}

/**
 * 给一个模型的所有网格绑定探针。
 * 已经绑定过的材质会被克隆一份 —— 否则"极速克隆"出来的第二个模型
 * 会和原模型共用同一组 uniform，被钉死在同一个房间的光照下。
 */
export function bindObjectProbe(root, uniforms) {
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;

    const list = Array.isArray(child.material) ? child.material : [child.material];
    const bound = list.map((mat) => {
      if (_binding.has(mat)) {
        const cloned = cloneMaterial(mat);
        patchRoomProbe(cloned, uniforms);
        return cloned;
      }
      patchRoomProbe(mat, uniforms);
      return mat;
    });

    child.material = Array.isArray(child.material) ? bound : bound[0];
  });
}

export { _binding };
