import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { setupHoldBtn } from './utils/ui.js';
import { createJoystick } from './controls/joystick.js';
import { initLightSync } from './network/light-sync.js';
import { generateThumbnail, clearThumbnailCache } from './utils/thumbnail.js';
import { ReflectionProbe } from './utils/reflection.js';
import { PostProcessing } from './utils/post-processing.js';

// ============================================================
// 1. 基础 3D 场景
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111122);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(5, 4, 6);
camera.lookAt(0, 1, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxDistance = 50;

// 灯光
const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
dirLight.position.set(5, 10, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1024, 1024);
scene.add(dirLight);

const pointLight = new THREE.PointLight(0xffaa00, 10, 15);
pointLight.position.set(-2, 3, 2);
scene.add(pointLight);

// 地面
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ============================================================
// 2. 初始化模块 (摇杆、网络、后期、反射)
// ============================================================
const statusEl = document.getElementById('status');
const joystick = createJoystick(
  document.getElementById('joystick-container'),
  document.getElementById('joystick-stick')
);
const lightSync = initLightSync(scene, (text, color) => {
  statusEl.textContent = text;
  statusEl.style.color = color;
});
const postProcessing = new PostProcessing(renderer, scene, camera);
const reflectionProbe = new ReflectionProbe(renderer, scene);

// ============================================================
// 3. UI 状态与工具台
// ============================================================
const modelSelect = document.getElementById('model-select'); // 保留以防报错，尽管现在用了画廊
const modelControls = document.getElementById('model-controls');
const selectedInfo = document.getElementById('selected-info');

let isCameraLocked = false;
let isDragEnabled = true;
let selectedModel = null;
let isModelMovingUp = false, isModelMovingDown = false;
let isCamMovingUp = false, isCamMovingDown = false;

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

// 高度按钮
setupHoldBtn(document.getElementById('btn-cam-up'), () => isCamMovingUp = true, () => isCamMovingUp = false);
setupHoldBtn(document.getElementById('btn-cam-down'), () => isCamMovingDown = true, () => isCamMovingDown = false);
setupHoldBtn(document.getElementById('btn-model-up'), () => isModelMovingUp = true, () => isModelMovingUp = false);
setupHoldBtn(document.getElementById('btn-model-down'), () => isModelMovingDown = true, () => isModelMovingDown = false);

// 工具台弹窗控制
const toolboxPanel = document.getElementById('toolbox-panel');
document.getElementById('advanced-toggle-btn').addEventListener('click', () => toolboxPanel.classList.toggle('show'));



// 工具台：光源与增强
const btnMainLight = document.getElementById('btn-main-light');
btnMainLight.addEventListener('click', () => {
  const isOn = !btnMainLight.classList.contains('active');
  btnMainLight.classList.toggle('active');
  scene.traverse(c => {
    if (c.isDirectionalLight) {
      c.visible = isOn;
      if (isOn) c.intensity = document.getElementById('btn-enhance').classList.contains('active') ? 0.8 : 2.5;
    }
  });
});

const btnPointLight = document.getElementById('btn-point-light');
btnPointLight.addEventListener('click', () => {
  const isOn = !btnPointLight.classList.contains('active');
  btnPointLight.classList.toggle('active');
  pointLight.visible = isOn;
});

const btnEnhance = document.getElementById('btn-enhance');
btnEnhance.addEventListener('click', () => {
  const enable = !btnEnhance.classList.contains('active');
  btnEnhance.classList.toggle('active');
  scene.traverse(child => {
    if (child.isMesh && child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(mat => {
        if (mat.isMeshStandardMaterial) {
          if (enable) {
            if (mat.userData._om === undefined) { mat.userData._om = mat.metalness; mat.userData._or = mat.roughness; }
            mat.metalness = 0.95; mat.roughness = 0.1;
          } else if (mat.userData._om !== undefined) {
            mat.metalness = mat.userData._om; mat.roughness = mat.userData._or;
          }
          mat.needsUpdate = true;
        }
      });
    }
  });
  if (btnMainLight.classList.contains('active')) dirLight.intensity = enable ? 0.8 : 2.5;
});

// 工具台：SSAO
const btnSSAO = document.getElementById('btn-ssao');
let isSSAOEnabled = false;
btnSSAO.addEventListener('click', () => {
  isSSAOEnabled = !isSSAOEnabled;
  btnSSAO.classList.toggle('active');
  postProcessing.setSSAO(isSSAOEnabled);
});

// 工具台：反射 & HDR
const btnReflect = document.getElementById('btn-reflect');
const btnHDR = document.getElementById('btn-hdr');

btnReflect.addEventListener('click', () => {
  if (reflectionProbe.mode === 'probe') {
    reflectionProbe.disable(); btnReflect.classList.remove('active');
  } else {
    if (reflectionProbe.mode === 'hdr') { reflectionProbe.disable(); btnHDR.classList.remove('active'); }
    const meshes = [];
    scene.traverse(c => { if (c.isMesh) { meshes.push(c); c.visible = false; }});
    reflectionProbe.enableProbe();
    meshes.forEach(c => c.visible = true);
    btnReflect.classList.add('active');
  }
});

btnHDR.addEventListener('click', async () => {
  if (reflectionProbe.mode === 'hdr') {
    reflectionProbe.disable(); btnHDR.classList.remove('active');
  } else {
    if (reflectionProbe.mode === 'probe') { reflectionProbe.disable(); btnReflect.classList.remove('active'); }
    btnHDR.textContent = '⏳ 加载中...';
    try {
      await reflectionProbe.loadHDR('https://threejs.org/examples/textures/equirectangular/venice_sunset_1k.hdr');
      btnHDR.textContent = '🌅 HDR 天空';
      btnHDR.classList.add('active');
    } catch (e) {
      btnHDR.textContent = '❌ 加载失败';
    }
  }
});

// 工具台：保存、导入、截图、刷新
const fileInput = document.getElementById('file-input');
document.getElementById('btn-save').addEventListener('click', () => {
  const layout = loadedModels.map(m => ({ url: m.userData.url, position: m.position.toArray(), rotation: m.rotation.toArray(), scale: m.scale.toArray() }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' }));
  a.download = `scene-layout-${Date.now()}.json`;
  a.click();
});
document.getElementById('btn-load').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const layout = JSON.parse(evt.target.result);
      loadedModels.forEach(m => scene.remove(m)); loadedModels.length = 0;
      for (const item of layout) await new Promise(r => loadModel(item.url, item, r));
    } catch (err) { console.error('导入失败', err); }
    fileInput.value = '';
  };
  reader.readAsText(file);
});
document.getElementById('btn-screenshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = renderer.domElement.toDataURL('image/png'); a.download = `screenshot-${Date.now()}.png`; a.click();
});
document.getElementById('btn-refresh-preview').addEventListener('click', () => {
  clearThumbnailCache(); fetchModels(); statusEl.textContent = '预览图缓存已刷新';
});
document.getElementById('btn-clear').addEventListener('click', () => {
  loadedModels.forEach(m => scene.remove(m)); loadedModels.length = 0;
  selectedModel = null; modelControls.style.opacity = '0.5'; modelControls.style.pointerEvents = 'none'; selectedInfo.style.display = 'none';
  toolboxPanel.classList.remove('show');
});

// ============================================================
// 4. 模型加载与拖放 (含极速克隆)
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
  } catch (e) { grid.innerHTML = '<div style="color:#f66; padding:20px; grid-column:span 2;">获取列表失败</div>'; }
}

// 弹窗控制
const el_open_picker_btn = document.getElementById('open-picker-btn');
if (el_open_picker_btn) el_open_picker_btn.addEventListener('click', () => document.getElementById('model-picker-overlay').classList.add('show'));
const el_close_picker_btn = document.getElementById('close-picker-btn');
if (el_close_picker_btn) el_close_picker_btn.addEventListener('click', () => document.getElementById('model-picker-overlay').classList.remove('show'));

function loadModel(url, transform = null, onComplete = null) {
  if (!url) return;
  statusEl.textContent = '加载中...';

  const handleModel = (model) => {
    model.name = url.split('/').pop() || '模型';
    model.userData.url = url;
    model.position.set(0,0,0); model.rotation.set(0,0,0); model.scale.set(1,1,1);
    model.updateMatrixWorld(true);

    if (transform) {
      model.position.fromArray(transform.position); model.rotation.fromArray(transform.rotation); model.scale.fromArray(transform.scale);
    } else {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.sub(center); model.position.y += size.y / 2;
      const scale = 2 / (Math.max(size.x, size.y, size.z) || 1);
      model.scale.setScalar(scale); model.position.y = (size.y / 2) * scale;
      model.position.x += (Math.random() - 0.5) * 3; model.position.z += (Math.random() - 0.5) * 3;
    }
    model.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    scene.add(model); loadedModels.push(model);
    statusEl.textContent = '已加载: ' + model.name;
    if (onComplete) onComplete();
  };

  if (modelCache.has(url)) {
    statusEl.textContent = '极速克隆中...';
    handleModel(SkeletonUtils.clone(modelCache.get(url)));
    return;
  }

  gltfLoader.load(url, (gltf) => {
    modelCache.set(url, gltf.scene);
    handleModel(gltf.scene.clone());
  }, undefined, () => statusEl.textContent = '加载失败');
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
        loadedModels.forEach(m => m.traverse(c => { if (c.isMesh && c.material) c.material.emissive?.setHex(0x000000); }));
        selectedModel = obj;
        selectedModel.traverse(c => { if (c.isMesh && c.material) c.material.emissive?.setHex(0x333333); });
        modelControls.style.opacity = '1'; modelControls.style.pointerEvents = 'auto';
        selectedInfo.style.display = 'block'; selectedInfo.textContent = `已选: ${selectedModel.name}`;
      }
      dragTarget = obj; controls.enabled = false;
      dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), dragTarget.position);
      raycaster.ray.intersectPlane(dragPlane, intersectionPoint);
      dragOffset.copy(dragTarget.position).sub(intersectionPoint);
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  } else {
    loadedModels.forEach(m => m.traverse(c => { if (c.isMesh && c.material) c.material.emissive?.setHex(0x000000); }));
    selectedModel = null; modelControls.style.opacity = '0.5'; modelControls.style.pointerEvents = 'none'; selectedInfo.style.display = 'none';
  }
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragTarget) return;
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  if (raycaster.ray.intersectPlane(dragPlane, intersectionPoint)) dragTarget.position.copy(intersectionPoint).add(dragOffset);
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragTarget) { dragTarget = null; if (!isCameraLocked) controls.enabled = true; renderer.domElement.releasePointerCapture(e.pointerId); }
});

// ============================================================
// 5. 渲染循环
// ============================================================
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  lightSync.update(dt);

  if (selectedModel && (isModelMovingUp || isModelMovingDown)) {
    if (isModelMovingUp) selectedModel.position.y += 5 * dt;
    if (isModelMovingDown) { selectedModel.position.y -= 5 * dt; if (selectedModel.position.y < 0.1) selectedModel.position.y = 0.1; }
  }

  if (!isCameraLocked && (isCamMovingUp || isCamMovingDown)) {
    let dy = (isCamMovingUp ? 8 : -8) * dt;
    if (camera.position.y + dy > 0.5) { camera.position.y += dy; controls.target.y += dy; }
  }

  const jVec = joystick.getVector();
  if (!isCameraLocked && jVec.lengthSq() > 0.01) {
    const camDir = new THREE.Vector3(); camera.getWorldDirection(camDir); camDir.y = 0; camDir.normalize();
    const right = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
    const move = new THREE.Vector3().addScaledVector(camDir, -jVec.y * 10 * dt).addScaledVector(right, jVec.x * 10 * dt);
    camera.position.add(move); controls.target.add(move);
  }

  pointLight.position.x = Math.sin(performance.now() * 0.001) * 3;
  pointLight.position.z = Math.cos(performance.now() * 0.001) * 3;

  if (controls.enabled) controls.update();
  postProcessing.render();
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  postProcessing.resize(innerWidth, innerHeight);
});
