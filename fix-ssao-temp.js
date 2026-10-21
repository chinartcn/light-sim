const fs = require('fs');
const file = 'client/src/main.js';
let code = fs.readFileSync(file, 'utf8');

// A. 引入 PostProcessing
if (!code.includes('PostProcessing')) {
  const importTarget = "import { ReflectionProbe } from './utils/reflection.js';";
  code = code.replace(importTarget, importTarget + "\nimport { PostProcessing } from './utils/post-processing.js';");
}

// B. 注入初始化和按钮事件
const initTarget = "// ============================================================\n// 反射探针逻辑";
const initReplacement = `// ============================================================
// 后期处理 (SSAO) 逻辑
// ============================================================
const postProcessing = new PostProcessing(renderer, scene, camera);
const toggleSSAOBtn = document.getElementById('toggle-ssao-btn');
let isSSAOEnabled = false;

if (toggleSSAOBtn) {
  toggleSSAOBtn.addEventListener('click', () => {
    isSSAOEnabled = !isSSAOEnabled;
    postProcessing.setSSAO(isSSAOEnabled);
    toggleSSAOBtn.textContent = isSSAOEnabled ? '☀️ 关闭环境光遮蔽' : '🌑 开启环境光遮蔽';
    toggleSSAOBtn.style.color = isSSAOEnabled ? '#6f6' : 'var(--text-main)';
  });
}

// ============================================================
// 反射探针逻辑`;

if (code.includes(initTarget) && !code.includes('postProcessing')) {
  code = code.replace(initTarget, initReplacement);
}

// C. 替换渲染循环
if (code.includes('renderer.render(scene, camera);')) {
  code = code.replace('renderer.render(scene, camera);', 'postProcessing.render();');
}

// D. 替换窗口尺寸调整
const resizeTarget = `addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});`;

const resizeReplacement = `addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  postProcessing.resize(innerWidth, innerHeight);
});`;

if (code.includes(resizeTarget)) {
  code = code.replace(resizeTarget, resizeReplacement);
}

fs.writeFileSync(file, code);
console.log('✅ main.js 修改成功');
