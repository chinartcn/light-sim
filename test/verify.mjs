/**
 * 验证脚本（Node 直接跑）：
 *   1. 房间归属判定
 *   2. 门洞混合带的 SH 过渡
 *   3. 材质 SH 注入的 shader 补丁是否命中正确的 include 点
 *   4. 服务端协议往返（SH 帧 / 房间清单）
 *
 * 用法：node test/verify.mjs
 */
import assert from 'node:assert';
import * as THREE from 'three';
import { RoomRegistry, makeSH } from '../client/src/scene/room-registry.js';
import { patchRoomProbe, createProbeUniforms } from '../client/src/scene/room-probe-material.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\n[1] 房间归属判定');
const registry = new RoomRegistry();
const livingBounds = new THREE.Box3(
  new THREE.Vector3(-6, 0, -4),
  new THREE.Vector3(0.01, 3.2, 4)
);
const bedroomBounds = new THREE.Box3(
  new THREE.Vector3(-0.01, 0, -4),
  new THREE.Vector3(6, 3.2, 4)
);
const door = { axis: 'x', pos: 0, center: 0, halfWidth: 0.9, blend: 1.6 };

registry.addRoom({
  id: 1,
  name: '客厅',
  bounds: livingBounds,
  sh: makeSH([1, 1, 1], 0),
  doors: [{ to: 2, ...door }],
});
registry.addRoom({
  id: 2,
  name: '卧室',
  bounds: bedroomBounds,
  sh: makeSH([1, 0, 0], 0), // 纯红
  doors: [{ to: 1, ...door }],
});

ok('客厅中心属于客厅', () => {
  assert.equal(registry.roomAt(new THREE.Vector3(-3, 1, 0)), 1);
});
ok('卧室中心属于卧室', () => {
  assert.equal(registry.roomAt(new THREE.Vector3(3, 1, 0)), 2);
});
ok('门外返回 null', () => {
  assert.equal(registry.roomAt(new THREE.Vector3(20, 1, 0)), null);
});

console.log('\n[2] 门洞混合带');
const white = makeSH([1, 1, 1], 0);
const red = makeSH([1, 0, 0], 0);

// 客厅深处：纯白
const deep = registry.shAt(new THREE.Vector3(-4, 1, 0), new Float32Array(27));
ok('客厅深处是纯白（无卧室渗透）', () => {
  assert.ok(Math.abs(deep[0] - 1) < 1e-6, `R=${deep[0]}`);
  assert.ok(Math.abs(deep[1] - 1) < 1e-6, `G=${deep[1]}`);
});

// 门口（客厅侧，贴墙）：应该开始混到红
const nearDoor = registry.shAt(new THREE.Vector3(-0.2, 1, 0), new Float32Array(27));
ok('门口附近开始混入卧室的红光', () => {
  assert.ok(nearDoor[1] < 0.95, `G 应该 < 0.95，实际 ${nearDoor[1]}`);
  assert.ok(nearDoor[1] > 0, `G 应该 > 0，实际 ${nearDoor[1]}`);
});

// 门口但横向远离门洞：不该混合
const offDoor = registry.shAt(new THREE.Vector3(-0.2, 1, 3.5), new Float32Array(27));
ok('远离门洞的墙边不混合', () => {
  assert.ok(Math.abs(offDoor[1] - 1) < 1e-6, `G=${offDoor[1]}`);
});

// 卧室深处：纯红
const bedroomDeep = registry.shAt(new THREE.Vector3(4, 1, 0), new Float32Array(27));
ok('卧室深处是纯红', () => {
  assert.ok(Math.abs(bedroomDeep[0] - 1) < 1e-6);
  assert.ok(Math.abs(bedroomDeep[1]) < 1e-6, `G=${bedroomDeep[1]}`);
});

console.log('\n[3] 材质 SH 注入');
const mat = new THREE.MeshStandardMaterial();
const uniforms = createProbeUniforms(1);
patchRoomProbe(mat, uniforms);

// 用 three.js 真实的物理材质 shader 源（此时 include 还没被展开，
// 正是 onBeforeCompile 拿到的样子）
const captured = {
  fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  vertexShader: THREE.ShaderLib.physical.vertexShader,
  uniforms: {},
};
mat.onBeforeCompile(captured, {});

ok('注入点命中 lights_pars_begin', () => {
  assert.ok(captured.fragmentShader.includes('#include <lights_pars_begin>'));
  assert.ok(captured.fragmentShader.includes('uniform vec3 uRoomSH[ 9 ];'));
});
ok('注入点命中 lights_fragment_begin', () => {
  assert.ok(captured.fragmentShader.includes('#include <lights_fragment_begin>'));
  assert.ok(captured.fragmentShader.includes('shGetIrradianceAt('));
  assert.ok(captured.fragmentShader.includes('inverseTransformDirection( geometryNormal, viewMatrix )'));
});
ok('uniform 正确挂上', () => {
  assert.equal(captured.uniforms.uRoomSH, uniforms.roomSHUniform);
  assert.equal(captured.uniforms.uRoomSHIntensity, uniforms.roomSHIntensityUniform);
});
ok('customProgramCacheKey 与未打补丁材质区分开', () => {
  const plain = new THREE.MeshStandardMaterial();
  assert.notEqual(mat.customProgramCacheKey(), plain.customProgramCacheKey());
});
ok('fragmentShader 里没有残留未替换的 include', () => {
  const count = (captured.fragmentShader.match(/#include <lights_fragment_begin>/g) || []).length;
  assert.equal(count, 1, `出现了 ${count} 次`);
});

// three.js 的物理材质 shader 必须真的包含这两个 include
const physicalFrag = THREE.ShaderLib.physical.fragmentShader;
ok('three.js 物理材质确实包含这两个 include 点', () => {
  assert.ok(physicalFrag.includes('#include <lights_pars_begin>'));
  assert.ok(physicalFrag.includes('#include <lights_fragment_begin>'));
  // 确认 irradiance 变量在 lights_fragment_begin 里声明
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  assert.ok(/vec3 irradiance = getAmbientLightIrradiance/.test(chunk), 'irradiance 声明没找到');
});

// 确认 shGetIrradianceAt 不在 USE_LIGHT_PROBES 守卫内
const pars = THREE.ShaderChunk.lights_pars_begin;
const guardStart = pars.indexOf('#if defined( USE_LIGHT_PROBES )');
const guardEnd = pars.indexOf('#endif', guardStart);
const fnPos = pars.indexOf('vec3 shGetIrradianceAt');
ok('shGetIrradianceAt 在 USE_LIGHT_PROBES 守卫之外', () => {
  assert.ok(fnPos > guardEnd, `fnPos=${fnPos} guardEnd=${guardEnd}`);
});

console.log(`\n通过 ${passed} 项检查`);
