import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 版本号升至 v6
const CACHE_VERSION = 'v6';
const CACHE_PREFIX = `tred_thumb_${CACHE_VERSION}_`;
const MAX_FILE_SIZE_MB = 20;

let globalRenderer = null;
function getRenderer() {
  if (!globalRenderer) {
    globalRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    globalRenderer.setSize(128, 128);
  }
  return globalRenderer;
}

export async function generateThumbnail(url) {
  const cacheKey = `${CACHE_PREFIX}${url}`;
  
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return cached;
  } catch (e) {}

  try {
    const res = await fetch(url, { method: 'HEAD' });
    const size = parseInt(res.headers.get('content-length') || '0');
    if (size > MAX_FILE_SIZE_MB * 1024 * 1024) return 'TOO_LARGE';
  } catch (e) {}

  return new Promise((resolve) => {
    let isSettled = false;
    const timeout = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        resolve('TIMEOUT');
      }
    }, 10000);

    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);

      try {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x222222);
        
        // FOV 45度，这是标准视角
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
        scene.add(new THREE.AmbientLight(0xffffff, 1.5));
        
        const dir = new THREE.DirectionalLight(0xffffff, 2);
        dir.position.set(2, 3, 2);
        scene.add(dir);

        const model = gltf.scene;
        model.updateMatrixWorld(true);

        // 1. 计算整个场景的真实包围球（包含所有网格）
        const box = new THREE.Box3().setFromObject(model);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        
        // 2. 安全防护：如果计算出来的半径是 0 或者 Infinity，给个默认值
        const radius = (sphere.radius && isFinite(sphere.radius)) ? sphere.radius : 1;
        const center = sphere.center || new THREE.Vector3(0,0,0);

        // 3. 将模型偏移，使其中心对齐到世界原点 (0,0,0)
        model.position.x -= center.x;
        model.position.y -= center.y;
        model.position.z -= center.z;

        // 4. 创建挂载组，统一缩放
        const group = new THREE.Group();
        group.add(model);
        
        // 缩放比例：将包围球半径统一放大/缩小至 1
        const scale = 1.0 / radius;
        group.scale.setScalar(scale);
        
        scene.add(group);

        // 5. 固定相机：由于包围球半径变成了 1，我们让相机距离原点 3.2 的距离
        // 3.2 的距离配合 45度 FOV，刚好能完美看到半径 1 的球体并留一点边距
        camera.position.set(1.5, 1.5, 1.5);
        camera.lookAt(0, 0, 0);
        camera.updateProjectionMatrix();

        const renderer = getRenderer();
        renderer.render(scene, camera);
        const dataURL = renderer.domElement.toDataURL('image/png');

        try { localStorage.setItem(cacheKey, dataURL); } catch (e) {}

        scene.clear(); 
        resolve(dataURL);
      } catch (err) {
        console.error('渲染失败', err);
        resolve('ERROR');
      }
    }, undefined, () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      resolve('ERROR');
    });
  });
}

export function clearThumbnailCache() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    keys.forEach(k => localStorage.removeItem(k));
    return keys.length;
  } catch (e) { return 0; }
}
