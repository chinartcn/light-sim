import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { setupHoldBtn } from './utils/ui.js';
import { createJoystick } from './controls/joystick.js';
import { LightSync } from './network/light-sync.js';
import { generateThumbnail, clearThumbnailCache } from './utils/thumbnail.js';
import { ReflectionProbe } from './utils/reflection.js';
import { PostProcessing } from './utils/post-processing.js';
import { QualityTier, HIGH, MID, LOW } from './utils/quality-tier.js';
import { RoomRegistry, makeSH } from './scene/room-registry.js';
import { patchRoomProbe } from './scene/room-probe-material.js';
import { buildRooms } from './scene/room-builder.js';

// ============================================================
// 1. 基础 3D 场景
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111122);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(-3, 1.65, 3.2);
camera.lookAt(-3, 1.4, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxDistance = 50;

// --- 质量档：先探测，再决定 pixelRatio / 后期 / 阴影 ---
const quality = new QualityTier();
quality.applyToRenderer(renderer);

// 灯光
// 注意：three.js 的灯光是全局的（不做 per-object 过滤），
// 所以这里用 distance 衰减让两盏点光各自待在自己房间，
// 真正实现"分区"的是下面的 per-material SH 探针。
const dirLight = new THREE.DirectionalLight(0xffffff, 0.25);
dirLight.position.set(5, 10, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

const livingLight = new THREE.PointLight(0xfff2e0, 6, 5.5, 2);
livingLight.position.set(-4.2, 2.85, 0);
livingLight.castShadow = true;
livingLight.shadow.mapSize.set(512, 512);
scene.add(livingLight);

const bedroomLight = new THREE.PointLight(0xff3b30, 5, 5.5, 2);
bedroomLight.position.set(4.2, 2.6, 0);
scene.add(bedroomLight);

// ============================================================
// 2. 房间系统
// ============================================================
const registry = new RoomRegistry();
const built = buildRooms(scene);

// 每个房间一份初始 SH（后端连上后会被推送值覆盖）
registry.addRoom({
  id: 1,
  name: '客厅',
  bounds: built.rooms[0].bounds,
  sh: makeSH([0.85, 0.87, 0.92], 0.12, [0.1, 0.1, 0.11]),
  doors: [{ to: 2, ...built.door }],
});
registry.addRoom({
  id: 2,
  name: '卧室',
  bounds: built.rooms[1].bounds,
  sh: makeSH([0.62, 0.07, 0.09], 0.22, [0.22, 0.02, 0.02]),
  doors: [{ to: 1, ...built.door }],
});

// 房间壳体材质绑定到各自房间（固定，不跟随位置）
for (const r of built.rooms) {
  // 用一个不可见的 holder 承载这组 uniform：
  // registry.update() 每帧把房间的 SH 写进 holder 的 uniform，
  // 壳体材质的 uRoomSH 指向同一个对象。
  const holder = new THREE.Object3D();
  holder.position.copy(r.center);
  const uniforms = registry.bindObject(holder, r.id, false);

  for (const mat of r.materials) {
    patchRoomProbe(mat, uniforms);
  }
}

// ============================================================
// 3. 初始化模块
// ============================================================
const statusEl = document.getElementById('status');
const roomInfoEl = document.getElementById('room-info');
const tierInfoEl = document.getElementById('tier-info');

const joystick = createJoystick(
  document.getElementById('joystick-container'),
  document.getElementById('joystick-stick')
);

const lightSync = new LightSync(registry, {
  url: `ws://${location.hostname}:4443`,
  onStatus: (text, color) => {
    statusEl.textContent = text;
    statusEl.style.color = color;
  },
  onRooms: (rooms) => {
    console.log('[rooms] 后端房间清单:', rooms);
  },
});
lightSync.connect();

const postProcessing = new PostProcessing(renderer, scene, camera);
const reflectionProbe = new ReflectionProbe(renderer, scene);

// ============================================================
// 4. 工具台状态
// ============================================================
const modelSelect = document.getElementById('model-select');
const modelControls = document.getElementById('model-controls');
const selectedInfo = document.getElementById('selected-info');

let isCameraLocked = false;
let isDragEnabled = true;
let selectedModel = null;
let isModelMovingUp = false, isModelMovingDown = false;
let isCamMovingUp = false, isCamMovingDown = false;

// 探针模式：'room' = per-material 分房间探针；'global' = scene 级全局探针（对照组）
let probeMode = 'room';
let globalProbes = [];

function setProbeMode(mode) {
  probeMode = mode;
  registry.setGlobalProbeMode(mode === 'global');

  for (const p of globalProbes) scene.remove(p);
  globalProbes = [];

  if (mode === 'global') {
    // 故意挂两个 —— 演示 three.js 会把它们的 SH **累加**进同一组 9 个系数，
    // 全场景只剩一个"白 + 红"的混合色，房间之间彻底串色。
    const a = new THREE.LightProbe(lightSync.toSphericalHarmonics(1), 1);
    const b = new THREE.LightProbe(lightSync.toSphericalHarmonics(2), 1);
    scene.add(a, b);
    globalProbes = [a, b];
  }

  // USE_LIGHT_PROBES 这个 define 变了，必须重编译材质
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m.needsUpdate = true;
  });

  const btn = document.getElementById('btn-probe-mode');
  if (btn) {
    btn.textContent = mode === 'room' ? '🔀 分房间探针' : '🌐 全局探针(对比)';
    btn.classList.toggle('active', mode === 'room');
  }
}

// 顶部状态按钮
document.getElementById('lock-cam-btn').addEventListener('click', (e) => {
  isCameraLocked = !isCameraLocked;
  controls.enabled = !isCameraLocked;
  e.target.textContent = isCameraLocked ? '🔓 解锁' : '🔒 锁定';
  e.target.style.background = isCameraLocked ? '#353' : '#1e2638';
  e.target.style.color = isCameraLocked ? '#6f6' : '#9cf';
});

document.getElementById('toggle-drag-btn').addEventListener('click', (e) => {
  isDragEnabled = !isDragEnabled;
  e.target.textContent = isDragEnabled ? '🖐️ 拖动' : '🚫 禁拖';
  e.target.style.background = isDragEnabled ? '#1e2638' : '#522';
  e.target.style.color = isDragEnabled ? '#9cf' : '#f66';
});

setupHoldBtn(document.getElementById('btn-cam-up'), () => (isCamMovingUp = true), () => (isCamMovingUp = false));
setupHoldBtn(document.getElementById('btn-cam-down'), () => (isCamMovingDown = true), () => (isCamMovingDown = false));
setupHoldBtn(document.getElementById('btn-model-up'), () => (isModelMovingUp = true), () => (isModelMovingUp = false));
setupHoldBtn(document.getElementById('btn-model-down'), () => (isModelMovingDown = true), () => (isModelMovingDown = false));

const toolboxPanel = document.getElementById('toolbox-panel');
document.getElementById('advanced-toggle-btn').addEventListener('click', () => toolboxPanel.classList.toggle('show'));

// 工具台：光源与增强
const btnMainLight = document.getElementById('btn-main-light');
const btnPointLight = document.getElementById('btn-point-light');
const btnEnhance = document.getElementById('btn-enhance');

btnMainLight.addEventListener('click', () => {
  const isOn = !btnMainLight.classList.contains('active');
  btnMainLight.classList.toggle('active');
  dirLight.visible = isOn;
  dirLight.intensity = isOn ? 0.25 : 0;
});

btnPointLight.addEventListener('click', () => {
  const isOn = !btnPointLight.classList.contains('active');
  btnPointLight.classList.toggle('active');
  livingLight.visible = isOn;
  bedroomLight.visible = isOn;
});

btnEnhance.addEventListener('click', () => {
  const enable = !btnEnhance.classList.contains('active');
  btnEnhance.classList.toggle('active');
  scene.traverse((c) => {
    if (c.isMesh && c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((mat) => {
        if (mat.isMeshStandardMaterial) {
          if (enable) {
            if (mat.userData._om === undefined) {
              mat.userData._om = mat.metalness;
              mat.userData._or = mat.roughness;
            }
            mat.metalness = 0.95;
            mat.roughness = 0.1;
          } else if (mat.userData._om !== undefined) {
            mat.metalness = mat.userData._om;
            mat.roughness = mat.userData._or;
          }
          mat.needsUpdate = true;
        }
      });
    }
  });
});

// 工具台：SSAO
const btnSSAO = document.getElementById('btn-ssao');
btnSSAO.addEventListener('click', () => {
  const on = !btnSSAO.classList.contains('active');
  btnSSAO.classList.toggle('active');
  postProcessing.setSSAO(on);
});

// 工具台：反射 & HDR
const btnReflect = document.getElementById('btn-reflect');
const btnHDR = document.getElementById('btn-hdr');

btnReflect.addEventListener('click', () => {
  if (reflectionProbe.mode === 'probe') {
    reflectionProbe.disable();
    btnReflect.classList.remove('active');
    return;
  }
  // 每房间烘一张 cubemap —— 不是一张全局的
  reflectionProbe.enableProbe();
  reflectionProbe.resolution = quality.settings.reflectionSize;
  for (const r of built.rooms) {
    const env = reflectionProbe.captureRoom(r.id, r.center, r.layerId);
    for (const mat of r.materials) reflectionProbe.applyToMaterial(mat, r.id);
    // 该房间里的模型也换上对应 envMap
    for (const b of registry.bound) {
      if (b.follow && registry.roomAt(b.obj.getWorldPosition(new THREE.Vector3())) === r.id) {
        b.obj.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => reflectionProbe.applyToMaterial(m, r.id));
        });
      }
    }
    void env;
  }
  reflectionProbe.setFallback(1);
  btnReflect.classList.add('active');
});

btnHDR.addEventListener('click', async () => {
  if (reflectionProbe.mode === 'hdr') {
    reflectionProbe.disable();
    btnHDR.classList.remove('active');
    return;
  }
  btnHDR.textContent = '⏳ 加载中...';
  try {
    await reflectionProbe.loadHDR(
      'https://threejs.org/examples/textures/equirectangular/venice_sunset_1k.hdr'
    );
    btnHDR.textContent = '🌅 HDR 天空';
    btnHDR.classList.add('active');
  } catch (e) {
    btnHDR.textContent = '❌ 加载失败';
  }
});

// 工具台：探针模式
const btnProbeMode = document.getElementById('btn-probe-mode');
if (btnProbeMode) {
  btnProbeMode.addEventListener('click', () => {
    setProbeMode(probeMode === 'room' ? 'global' : 'room');
  });
}

// 工具台：质量档
const btnTier = document.getElementById('btn-tier');
if (btnTier) {
  btnTier.addEventListener('click', () => {
    const order = [HIGH, MID, LOW];
    const next = order[(order.indexOf(quality.tier) + 1) % order.length];
    quality.setManual(next);
  });
}

// 工具台：保存、导入、截图、刷新
const fileInput = document.getElementById('file-input');

/**
 * 场景清单 —— 这就是"可分享场景"的数据模型。
 * 关键：物体清单和房间/光照是**分开**的，改动物体不会污染房间。
 */
function buildManifest() {
  return {
    version: 2,
    rooms: [...registry.rooms.values()].map((r) => ({
      id: r.id,
      name: r.name,
      sh: Array.from(r.sh),
    })),
    slots: loadedModels.map((m, i) => {
      const p = m.getWorldPosition(new THREE.Vector3());
      return {
        slotId: `s_${String(i).padStart(2, '0')}`,
        assetId: m.userData.url,
        roomId: registry.roomAt(p),
        transform: {
          position: m.position.toArray(),
          rotation: [m.rotation.x, m.rotation.y, m.rotation.z],
          scale: m.scale.toArray(),
        },
      };
    }),
  };
}

document.getElementById('btn-save').addEventListener('click', () => {
  const data = JSON.stringify(buildManifest(), null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `scene-manifest-${Date.now()}.json`;
  a.click();
});

document.getElementById('btn-load').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const manifest = JSON.parse(evt.target.result);
      // 房间光照
      for (const r of manifest.rooms || []) registry.setRoomSH(r.id, r.sh);
      // 物体
      loadedModels.forEach((m) => {
        scene.remove(m);
        registry.unbindObject(m);
      });
      loadedModels.length = 0;
      for (const item of manifest.slots || []) {
        await new Promise((r) =>
          loadModel(item.assetId, item.transform, r, item.roomId)
        );
      }
    } catch (err) {
      console.error('导入失败', err);
    }
    fileInput.value = '';
  };
  reader.readAsText(file);
});

document.getElementById('btn-screenshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png');
  a.download = `screenshot-${Date.now()}.png`;
  a.click();
});

document.getElementById('btn-refresh-preview').addEventListener('click', () => {
  clearThumbnailCache();
  fetchModels();
  statusEl.textContent = '预览图缓存已刷新';
});

document.getElementById('btn-clear').addEventListener('click', () => {
  loadedModels.forEach((m) => {
    scene.remove(m);
    registry.unbindObject(m);
  });
  loadedModels.length = 0;
  selectedModel = null;
  modelControls.style.opacity = '0.5';
  modelControls.style.pointerEvents = 'none';
  selectedInfo.style.display = 'none';
  toolboxPanel.classList.remove('show');
});

// ============================================================
// 5. 模型加载与拖放
// ============================================================
const gltfLoader = new GLTFLoader();
const modelCache = new Map();
const loadedModels = [];

async function fetchModels() {
  const grid = document.getElementById('model-grid');
  try {
    const res = await fetch('/api/models');
    const list = await res.json();
    grid.innerHTML = '';
    list.forEach(async (url) => {
      const name = url.split('/').pop();
      const card = document.createElement('div');
      card.className = 'model-card';
      card.innerHTML = `<div class="model-thumb">生成中...</div><div class="model-name">${name}</div>`;
      card.addEventListener('click', () => {
        loadModel(url);
        document.getElementById('model-picker-overlay').classList.remove('show');
      });
      grid.appendChild(card);

      const thumbDiv = card.querySelector('.model-thumb');
      const result = await generateThumbnail(url);
      if (result === 'TOO_LARGE') thumbDiv.innerHTML = '📦 模型过大';
      else if (result === 'ERROR' || !result) thumbDiv.innerHTML = '⚠️ 预览失败';
      else thumbDiv.innerHTML = `<img src="${result}" />`;
    });
  } catch (e) {
    grid.innerHTML = `<div style="color:#f66; padding:20px; grid-column:span 2;">获取列表失败</div>`;
  }
}

const el_open_picker_btn = document.getElementById('open-picker-btn');
if (el_open_picker_btn)
  el_open_picker_btn.addEventListener('click', () =>
    document.getElementById('model-picker-overlay').classList.add('show')
  );
const el_close_picker_btn = document.getElementById('close-picker-btn');
if (el_close_picker_btn)
  el_close_picker_btn.addEventListener('click', () =>
    document.getElementById('model-picker-overlay').classList.remove('show')
  );

function loadModel(url, transform = null, onComplete = null, roomId = null) {
  if (!url) return;
  statusEl.textContent = '加载中...';

  const handleModel = (model) => {
    model.name = url.split('/').pop() || '模型';
    model.userData.url = url;
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);

    if (transform) {
      model.position.fromArray(transform.position);
      model.rotation.set(...transform.rotation);
      model.scale.fromArray(transform.scale);
    } else {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center);
      model.position.y += size.y / 2;
      const scale = 2 / (Math.max(size.x, size.y, size.z) || 1);
      model.scale.setScalar(scale);
      model.position.y = (size.y / 2) * scale;
      // 默认落在客厅，别丢在门口的墙上
      model.position.x = -3 + (Math.random() - 0.5) * 2;
      model.position.z = (Math.random() - 0.5) * 3;
    }
    model.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });

    scene.add(model);
    loadedModels.push(model);

    // 绑定房间探针：follow = true → 每帧按物体当前位置取 SH，
    // 所以把模型从客厅拖进卧室，它会自己变成被红光照亮的。
    const bound = registry.bindObject(model, roomId ?? registry.roomAt(model.position), true);
    applyContactShadow(model, bound);

    statusEl.textContent = '已加载: ' + model.name;
    if (onComplete) onComplete();
  };

  if (modelCache.has(url)) {
    statusEl.textContent = '极速克隆中...';
    handleModel(SkeletonUtils.clone(modelCache.get(url)));
    return;
  }

  gltfLoader.load(
    url,
    (gltf) => {
      modelCache.set(url, gltf.scene);
      handleModel(gltf.scene.clone());
    },
    undefined,
    () => (statusEl.textContent = '加载失败')
  );
}

/** 接触阴影贴片：低配机上比 SSAO 便宜太多，效果立竿见影 */
let contactShadowTex = null;
function getContactShadowTexture() {
  if (contactShadowTex) return contactShadowTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.75)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  contactShadowTex = new THREE.CanvasTexture(c);
  contactShadowTex.colorSpace = THREE.SRGBColorSpace;
  return contactShadowTex;
}

function applyContactShadow(model, uniforms) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z) * 0.55;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(r, r),
    new THREE.MeshBasicMaterial({
      map: getContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      blending: THREE.NormalBlending,
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -size.y / 2 + 0.012;
  mesh.renderOrder = -1;
  model.add(mesh);
  void uniforms;
}

fetchModels();

// 拖放交互
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragTarget = null;
const dragPlane = new THREE.Plane();
const dragOffset = new THREE.Vector3();
const intersectionPoint = new THREE.Vector3();

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!isDragEnabled) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObjects(loadedModels, true);

  if (intersects.length > 0) {
    let obj = intersects[0].object;
    while (obj.parent && !loadedModels.includes(obj)) obj = obj.parent;
    if (loadedModels.includes(obj)) {
      if (selectedModel !== obj) {
        loadedModels.forEach((m) =>
          m.traverse((c) => {
            if (c.isMesh && c.material) c.material.emissive?.setHex(0x000000);
          })
        );
        selectedModel = obj;
        selectedModel.traverse((c) => {
          if (c.isMesh && c.material) c.material.emissive?.setHex(0x333333);
        });
        modelControls.style.opacity = '1';
        modelControls.style.pointerEvents = 'auto';
        selectedInfo.style.display = 'block';
        selectedInfo.textContent = `已选: ${selectedModel.name}`;
      }
      dragTarget = obj;
      controls.enabled = false;
      dragPlane.setFromNormalAndCoplanarPoint(
        new THREE.Vector3(0, 1, 0),
        dragTarget.position
      );
      raycaster.ray.intersectPlane(dragPlane, intersectionPoint);
      dragOffset.copy(dragTarget.position).sub(intersectionPoint);
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  } else {
    loadedModels.forEach((m) =>
      m.traverse((c) => {
        if (c.isMesh && c.material) c.material.emissive?.setHex(0x000000);
      })
    );
    selectedModel = null;
    modelControls.style.opacity = '0.5';
    modelControls.style.pointerEvents = 'none';
    selectedInfo.style.display = 'none';
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragTarget) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, intersectionPoint)) {
    dragTarget.position.copy(intersectionPoint).add(dragOffset);
  }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragTarget) {
    dragTarget = null;
    if (!isCameraLocked) controls.enabled = true;
    renderer.domElement.releasePointerCapture(e.pointerId);
  }
});

// ============================================================
// 6. 渲染循环
// ============================================================
const clock = new THREE.Clock();
let uiTick = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  // 后端 SH → 房间注册表（带插值）
  lightSync.update(dt);
  // 房间注册表 → 每个物体的 uniform（含门洞混合）
  registry.update();

  // 全局探针对照模式：把两间房的 SH 喂给 scene 级 LightProbe（会被累加）
  if (probeMode === 'global' && globalProbes.length === 2) {
    globalProbes[0].sh = lightSync.toSphericalHarmonics(1);
    globalProbes[1].sh = lightSync.toSphericalHarmonics(2);
  }

  if (selectedModel && (isModelMovingUp || isModelMovingDown)) {
    if (isModelMovingUp) selectedModel.position.y += 5 * dt;
    if (isModelMovingDown) {
      selectedModel.position.y -= 5 * dt;
      if (selectedModel.position.y < 0.1) selectedModel.position.y = 0.1;
    }
  }

  if (!isCameraLocked && (isCamMovingUp || isCamMovingDown)) {
    let dy = isCamMovingUp ? 8 : -8;
    dy *= dt;
    if (camera.position.y + dy > 0.5) {
      camera.position.y += dy;
      controls.target.y += dy;
    }
  }

  const jVec = joystick.getVector();
  if (!isCameraLocked && jVec.lengthSq() > 0.01) {
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.y = 0;
    camDir.normalize();
    const right = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
    const move = new THREE.Vector3()
      .addScaledVector(camDir, -jVec.y * 10 * dt)
      .addScaledVector(right, jVec.x * 10 * dt);
    camera.position.add(move);
    controls.target.add(move);
  }

  if (controls.enabled) controls.update();
  postProcessing.render();

  // UI 节流刷新
  uiTick += dt;
  if (uiTick > 0.25) {
    uiTick = 0;
    const rid = registry.roomAt(camera.position);
    const room = rid ? registry.getRoom(rid) : null;
    if (roomInfoEl) {
      roomInfoEl.textContent = room ? `📍 ${room.name}` : '📍 房间外';
      roomInfoEl.style.color = room ? (rid === 1 ? '#9cf' : '#f88') : '#888';
    }
    if (tierInfoEl) {
      const d = quality.describe();
      tierInfoEl.textContent = `⚙️ ${d.label}${d.auto ? '(自动)' : ''} · dpr${d.pixelRatio}`;
      tierInfoEl.style.color = d.tier === LOW ? '#fa0' : d.tier === MID ? '#fc6' : '#6f6';
    }
  }
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  quality.applyToRenderer(renderer);
  renderer.setSize(innerWidth, innerHeight);
  postProcessing.resize(innerWidth, innerHeight);
});

// 质量档变化 → 同步到 renderer / 后期
quality.onChange((tier, settings) => {
  quality.applyToRenderer(renderer);
  postProcessing.applyTier(settings);
  dirLight.shadow.mapSize.set(settings.shadowMapSize, settings.shadowMapSize);
  if (dirLight.shadow.map) {
    dirLight.shadow.map.dispose();
    dirLight.shadow.map = null;
  }
  livingLight.shadow.mapSize.set(
    Math.min(512, settings.shadowMapSize),
    Math.min(512, settings.shadowMapSize)
  );
  reflectionProbe.resolution = settings.reflectionSize;
  console.log('[quality] 切换到', tier, settings);
});
postProcessing.applyTier(quality.settings);
quality.watchFPS(renderer);

setProbeMode('room');

// 调试出口
window.__roomSim = { scene, camera, registry, quality, lightSync, built, loadedModels };
