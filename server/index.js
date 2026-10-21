import { WebSocketServer } from 'ws';

// 模拟低频全局光数据
function computeGlobalLightFrame(frameId) {
  const t = frameId / 60;
  const sh = new Float32Array(9);
  sh[0] = 1.0 + 0.1 * Math.sin(t);
  sh[1] = 0.2 * Math.sin(t * 0.7);
  sh[2] = 0.15 * Math.cos(t * 0.5);
  sh[3] = 0.05 * Math.sin(t * 1.3);
  sh[4] = 0.05 * Math.cos(t * 0.9);
  sh[5] = 0.02; sh[6] = 0.02; sh[7] = 0.02; sh[8] = 0.01;

  const tiles = [];
  for (let i = 0; i < 4; i++) {
    const buf = new Uint8Array(1024);
    buf[0] = frameId & 0xff;
    buf[1] = (frameId >> 8) & 0xff;
    buf[2] = i;
    tiles.push({ index: i, data: buf });
  }
  return { frameId, timestamp: Date.now(), sh, tiles };
}

const wss = new WebSocketServer({ port: 4443 });
console.log('✅ WebSocket 监听中: ws://localhost:4443');

let globalFrameId = 0;

wss.on('connection', (ws) => {
  console.log('📡 客户端已连接');

  const interval = setInterval(() => {
    try {
      const frame = computeGlobalLightFrame(globalFrameId++);

      // --- 发送 SH 数据 ---
      // 协议头: [类型:1字节=0] [frameId:4字节] [timestamp:8字节] [sh:36字节]
      const shBuf = new ArrayBuffer(1 + 4 + 8 + 36);
      const shView = new DataView(shBuf);
      shView.setUint8(0, 0); // Type 0 = SH
      shView.setUint32(1, frame.frameId, true);
      shView.setFloat64(5, frame.timestamp, true);
      for (let i = 0; i < 9; i++) {
        shView.setFloat32(13 + i * 4, frame.sh[i], true);
      }
      ws.send(Buffer.from(shBuf));

      // --- 发送 Tile 数据 ---
      for (const tile of frame.tiles) {
        // 协议头: [类型:1字节=1] [frameId:4字节] [tileIndex:4字节] [data:1024字节]
        const tileBuf = new ArrayBuffer(1 + 4 + 4 + tile.data.byteLength);
        const tileView = new DataView(tileBuf);
        tileView.setUint8(0, 1); // Type 1 = Tile
        tileView.setUint32(1, frame.frameId, true);
        tileView.setUint32(5, tile.index, true);
        new Uint8Array(tileBuf).set(tile.data, 9);
        ws.send(Buffer.from(tileBuf));
      }
    } catch (e) {
      console.warn('发送异常:', e.message);
    }
  }, 1000 / 15); // 15Hz

  ws.on('close', () => {
    clearInterval(interval);
    console.log('🔌 客户端已断开');
  });
});
