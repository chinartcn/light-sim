import * as THREE from 'three';

export function initLightSync(scene, onStatusChange) {
  let latestFrameId = -1;
  const prevSH = new Float32Array(9), currSH = new Float32Array(9);
  let shInterpT = 0;

  const sh = new THREE.SphericalHarmonics3();
  sh.coefficients[0].set(1, 1, 1); // 初始白底
  const globalProbe = new THREE.LightProbe(sh, 1);
  scene.add(globalProbe);

  function connect() {
    const ws = new WebSocket('ws://localhost:4443');
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => onStatusChange('WebSocket 已连接', '#6f6');
    ws.onmessage = (event) => {
      const buffer = event.data;
      if (!(buffer instanceof ArrayBuffer)) return;
      const view = new DataView(buffer);
      const type = view.getUint8(0);

      if (type === 0 && buffer.byteLength >= 49) {
        const frameId = view.getUint32(1, true);
        const timestamp = view.getFloat64(5, true);
        if (frameId <= latestFrameId || Date.now() - timestamp > 200) return;

        latestFrameId = frameId;
        prevSH.set(currSH);
        for (let i = 0; i < 9; i++) currSH[i] = view.getFloat32(13 + i * 4, true);
        shInterpT = 0;
      }
    };

    ws.onclose = () => {
      onStatusChange('WebSocket 断开，重连中...', '#f66');
      setTimeout(connect, 2000);
    };
  }
  connect();

  // 提供给 animate 循环的更新函数
  return {
    update(dt) {
      if (latestFrameId >= 0) {
        shInterpT = Math.min(1, shInterpT + dt * 8);
        for (let i = 0; i < 9; i++) {
          sh.coefficients[i].setScalar(prevSH[i] * (1 - shInterpT) + currSH[i] * shInterpT);
        }
        globalProbe.sh = sh;
      }
    }
  };
}
