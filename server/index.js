import { WebSocketServer } from 'ws';

/**
 * 灯光服务 —— 推送"按房间"分组的低频全局光 (SH)。
 *
 * 协议 v1（见 client/src/network/light-sync.js 的注释）。
 *
 * 关键变化：v0 是"全局一份 SH"，v1 是"每个房间一份 SH"。
 * 这是多房间场景（客厅白光 / 卧室红光）能成立的前提。
 */

const TYPE_SH = 0;
const TYPE_ROOMS = 2;
const SH_COEFFS = 9;
const SH_FLOATS = SH_COEFFS * 3; // 27 = 9 系数 × RGB

/**
 * 构造一份 9 系数 × RGB 的 SH。
 * 系数顺序同 three.js SphericalHarmonics3：
 *   [0] DC, [1] band1 y, [2] band1 z, [3] band1 x, ...
 * 这里只用 DC + band1 y（够表达"从天花板来的光"）。
 */
function baseSH(dc, up = [0, 0, 0]) {
  const sh = new Float32Array(SH_FLOATS);
  sh[0] = dc[0];
  sh[1] = dc[1];
  sh[2] = dc[2];
  sh[3] = up[0];
  sh[4] = up[1];
  sh[5] = up[2];
  return sh;
}

/** 房间定义：id / 名称 / 基准 SH */
const ROOMS = [
  {
    id: 1,
    name: '客厅',
    // 冷白日光：DC 偏白 + 一点点从上方来的光
    base: baseSH([0.85, 0.87, 0.92], [0.1, 0.1, 0.11]),
  },
  {
    id: 2,
    name: '卧室',
    // 红色氛围灯：DC 强红 + 少量向上
    base: baseSH([0.62, 0.07, 0.09], [0.22, 0.02, 0.02]),
  },
];

/**
 * 计算某一时刻的房间 SH。
 * 这里做了一个很慢的呼吸，方便确认"网络 → 插值 → 材质"这条链是活的。
 */
function computeRoomSH(room, t) {
  const sh = new Float32Array(SH_FLOATS);
  sh.set(room.base);

  if (room.id === 2) {
    const pulse = 1 + 0.08 * Math.sin(t * 0.6);
    sh[0] *= pulse;
    sh[1] *= pulse;
    sh[2] *= pulse;
  } else if (room.id === 1) {
    const pulse = 1 + 0.04 * Math.sin(t * 0.4 + 1.2);
    sh[0] *= pulse;
    sh[1] *= pulse;
    sh[2] *= pulse;
  }
  return sh;
}

function buildSHFrame(frameId) {
  const t = frameId / 30;
  const timestamp = Date.now();
  const perRoom = ROOMS.map((r) => ({
    id: r.id,
    sh: computeRoomSH(r, t),
  }));

  const perRoomBytes = 2 + SH_FLOATS * 4;
  const buf = new ArrayBuffer(15 + perRoom.length * perRoomBytes);
  const view = new DataView(buf);
  view.setUint8(0, TYPE_SH);
  view.setUint32(1, frameId, true);
  view.setFloat64(5, timestamp, true);
  view.setUint16(13, perRoom.length, true);

  let offset = 15;
  for (const r of perRoom) {
    view.setUint16(offset, r.id, true);
    offset += 2;
    for (let i = 0; i < SH_FLOATS; i++) {
      view.setFloat32(offset + i * 4, r.sh[i], true);
    }
    offset += SH_FLOATS * 4;
  }
  return Buffer.from(buf);
}

function buildRoomList() {
  const names = ROOMS.map((r) => new TextEncoder().encode(r.name));
  const total = names.reduce((s, n) => s + n.length, 0);
  const buf = new ArrayBuffer(3 + ROOMS.length * 3 + total);
  const view = new DataView(buf);
  view.setUint8(0, TYPE_ROOMS);
  view.setUint16(1, ROOMS.length, true);

  let offset = 3;
  ROOMS.forEach((r, i) => {
    view.setUint16(offset, r.id, true);
    offset += 2;
    view.setUint8(offset, names[i].length);
    offset += 1;
    new Uint8Array(buf, offset, names[i].length).set(names[i]);
    offset += names[i].length;
  });
  return Buffer.from(buf);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4443;
const wss = new WebSocketServer({ port: PORT });
console.log(`✅ WebSocket 监听中: ws://localhost:${PORT}`);
console.log(`   房间: ${ROOMS.map((r) => `${r.id}=${r.name}`).join(', ')}`);

let globalFrameId = 0;

wss.on('connection', (ws) => {
  console.log('📡 客户端已连接');

  // 先推一次房间清单
  ws.send(buildRoomList());

  // 房间光照是静态的，4Hz 足够；只有实时编辑会话才需要更高频率
  const interval = setInterval(() => {
    try {
      ws.send(buildSHFrame(globalFrameId++));
    } catch (e) {
      console.warn('发送异常:', e.message);
    }
  }, 250);

  ws.on('close', () => {
    clearInterval(interval);
    console.log('🔌 客户端已断开');
  });
});
