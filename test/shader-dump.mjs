import * as THREE from 'three';
import { patchRoomProbe, createProbeUniforms } from '../client/src/scene/room-probe-material.js';

const mat = new THREE.MeshStandardMaterial();
const u = createProbeUniforms(1);
patchRoomProbe(mat, u);

const cap = {
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  uniforms: {},
};
mat.onBeforeCompile(cap, {});

const s = cap.fragmentShader;
const i = s.indexOf('#include <lights_fragment_begin>');
console.log('--- 注入后的 shader 片段 ---');
console.log(s.slice(i - 30, i + 400));
console.log('\n--- 依赖检查 ---');
const common = THREE.ShaderChunk.common;
console.log('common 有 inverseTransformDirection :', common.includes('inverseTransformDirection'));
const phys = THREE.ShaderLib.physical.fragmentShader;
console.log('physical frag 有 lights_pars_begin   :', phys.includes('#include <lights_pars_begin>'));
console.log('physical frag 有 lights_fragment_begin:', phys.includes('#include <lights_fragment_begin>'));
const lp = THREE.ShaderChunk.lights_pars_begin;
console.log('lights_pars_begin 有 shGetIrradianceAt:', lp.includes('shGetIrradianceAt'));

// 确认 inverseTransformDirection 不在 #ifdef 里（否则可能是 undefined）
const cIdx = common.indexOf('vec3 inverseTransformDirection');
const pre = common.slice(Math.max(0, cIdx - 400), cIdx);
console.log('inverseTransformDirection 前 400 字符里有 #if:', pre.includes('#if'));
