import * as THREE from 'three';

/**
 * 灯光同步 —— 后端推送"按房间"分组的低频全局光 (SH)。
 *
 * 协议 v1（二进制，小端）：
 *
 *   [0]      type: u8
 *              0 = SH 帧
 *              2 = 房间清单
 *   SH 帧:
 *   [1..4]   frameId: u32
 *   [5..12]  timestamp: f64
 *   [13..14] roomCount: u16
 *   每房间:
 *     [0..1]  roomId: u16
 *     [2..]   sh: 27 × f32   (9 个系数 × RGB，顺序同 three.js SphericalHarmonics3)
 *
 *   房间清单:
 *   [1..2]   roomCount: u16
 *   每房间:
 *     [0..1]  roomId: u16
 *     [2]     nameLen: u8
 *     [3..]   name: utf8
 *
 * 相比 v0 的变化：SH 从"全局一份 9 个标量"变成"每房间一份 27 个 RGB 系数"。
 * 这是多房间场景的前提。
 */

const TYPE_SH = 0;
const TYPE_ROOMS = 2;

const SH_COEFFS = 9;
const SH_FLOATS = SH_COEFFS * 3;

export class LightSync {
  /**
   * @param {import('../scene/room-registry.js').RoomRegistry} registry
   */
  constructor(registry, options = {}) {
    this.registry = registry;
    this.url = options.url || 'ws://localhost:4443';
    this.onStatus = options.onStatus || (() => {});
    this.onRooms = options.onRooms || (() => {});

    /** @type {Map<number,{prev:Float32Array,curr:Float32Array,t:number}>} */
    this.roomState = new Map();
    this.latestFrameId = -1;
    this.ws = null;
    this.connected = false;
    this.interpSpeed = options.interpSpeed || 6;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this.onStatus(`WebSocket 创建失败: ${e.message}`, '#f66');
      setTimeout(() => this.connect(), 2000);
      return;
    }
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.connected = true;
      this.onStatus('WebSocket 已连接', '#6f6');
    };

    this.ws.onmessage = (event) => {
      const buffer = event.data;
      if (!(buffer instanceof ArrayBuffer)) return;
      try {
        this._handle(buffer);
      } catch (e) {
        console.warn('[light-sync] 消息解析失败', e);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.onStatus('WebSocket 断开，重连中...', '#f66');
      setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = () => {
      this.onStatus('WebSocket 错误', '#f66');
    };
  }

  _handle(buffer) {
    const view = new DataView(buffer);
    const type = view.getUint8(0);

    if (type === TYPE_SH) {
      if (buffer.byteLength < 15) return;
      const frameId = view.getUint32(1, true);
      const timestamp = view.getFloat64(5, true);
      if (frameId <= this.latestFrameId) return;
      // 丢弃超过 500ms 的陈旧帧（网络抖动时避免画面跳变）
      if (Date.now() - timestamp > 500) return;
      this.latestFrameId = frameId;

      const roomCount = view.getUint16(13, true);
      let offset = 15;

      for (let i = 0; i < roomCount; i++) {
        if (offset + 2 + SH_FLOATS * 4 > buffer.byteLength) break;
        const roomId = view.getUint16(offset, true);
        offset += 2;

        const sh = new Float32Array(SH_FLOATS);
        for (let k = 0; k < SH_FLOATS; k++) {
          sh[k] = view.getFloat32(offset + k * 4, true);
        }
        offset += SH_FLOATS * 4;

        let state = this.roomState.get(roomId);
        if (!state) {
          state = {
            prev: new Float32Array(SH_FLOATS),
            curr: new Float32Array(SH_FLOATS),
            t: 1,
          };
          this.roomState.set(roomId, state);
        }
        state.prev.set(state.curr);
        state.curr.set(sh);
        state.t = 0;
      }
      return;
    }

    if (type === TYPE_ROOMS) {
      const count = view.getUint16(1, true);
      let offset = 3;
      const rooms = [];
      for (let i = 0; i < count; i++) {
        if (offset + 3 > buffer.byteLength) break;
        const roomId = view.getUint16(offset, true);
        offset += 2;
        const nameLen = view.getUint8(offset);
        offset += 1;
        const name = new TextDecoder().decode(
          new Uint8Array(buffer, offset, nameLen)
        );
        offset += nameLen;
        rooms.push({ id: roomId, name });
      }
      this.onRooms(rooms);
    }
  }

  /**
   * 每帧调用：把插值结果写回房间注册表。
   */
  update(dt) {
    for (const [roomId, state] of this.roomState) {
      if (state.t < 1) {
        state.t = Math.min(1, state.t + dt * this.interpSpeed);
      }
      const k = state.t;
      const blended = new Float32Array(SH_FLOATS);
      for (let i = 0; i < SH_FLOATS; i++) {
        blended[i] = state.prev[i] * (1 - k) + state.curr[i] * k;
      }
      this.registry.setRoomSH(roomId, blended);
    }
  }

  /**
   * 把当前 SH 包装成 three.js 的 SphericalHarmonics3（用于 scene 级对照探针）。
   */
  toSphericalHarmonics(roomId) {
    const room = this.registry.getRoom(roomId);
    const sh = new THREE.SphericalHarmonics3();
    if (!room) return sh;
    for (let i = 0; i < SH_COEFFS; i++) {
      sh.coefficients[i].set(
        room.sh[i * 3],
        room.sh[i * 3 + 1],
        room.sh[i * 3 + 2]
      );
    }
    return sh;
  }

  dispose() {
    if (this.ws) this.ws.close();
  }
}
