import * as THREE from 'three';
import { createProbeUniforms, bindObjectProbe, writeSH } from './room-probe-material.js';

/**
 * 房间注册表 —— 整个"分房间"架构的中枢。
 *
 * 职责：
 *  1. 记录房间的空间范围（AABB）与门洞信息
 *  2. 持有每个房间当前的 SH（27 个数 = 9 系数 × RGB）
 *  3. 回答"这个位置属于哪个房间" / "这个位置应该被什么光照到"
 *  4. 给场景里的物体绑定探针材质，并每帧把混合后的 SH 回写进 uniform
 *
 * 门洞过渡：两个房间共享一堵墙时，墙附近存在一个混合带。
 * 站在客厅靠近门口，客厅的物体开始吃到卧室的红色，这就是"门洞过渡带"。
 */

const SH_COEFFS = 9;
const SH_CHANNELS = 3;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class RoomRegistry {
  constructor() {
    /** @type {Map<number, object>} roomId -> room */
    this.rooms = new Map();
    /** @type {Array<{obj:THREE.Object3D, uniforms:object, roomId:number, follow:boolean}>} */
    this.bound = [];
    this.globalProbeMode = false;
    this._tmp = new THREE.Vector3();
    this._sh = new Float32Array(SH_COEFFS * SH_CHANNELS);
  }

  /**
   * @param {object} def
   * @param {number} def.id
   * @param {string} def.name
   * @param {THREE.Box3} def.bounds
   * @param {number[]} [def.sh] 27 个数，9 系数 × RGB
   * @param {Array} [def.doors] [{ to, axis:'x'|'z', pos, center, halfWidth, blend }]
   */
  addRoom(def) {
    const sh = new Float32Array(SH_COEFFS * SH_CHANNELS);
    if (def.sh) sh.set(def.sh);
    this.rooms.set(def.id, {
      id: def.id,
      name: def.name || `room_${def.id}`,
      bounds: def.bounds || new THREE.Box3(),
      sh,
      doors: def.doors || [],
      shell: [],
    });
    return this.rooms.get(def.id);
  }

  getRoom(id) {
    return this.rooms.get(id);
  }

  /** 写入某房间的 SH（27 个数） */
  setRoomSH(id, coeffs) {
    const room = this.rooms.get(id);
    if (!room) return;
    if (coeffs.length === room.sh.length) {
      room.sh.set(coeffs);
    } else {
      // 兼容 9 个标量的旧格式（灰度）
      for (let i = 0; i < SH_COEFFS; i++) {
        const v = coeffs[i] || 0;
        room.sh[i * 3] = v;
        room.sh[i * 3 + 1] = v;
        room.sh[i * 3 + 2] = v;
      }
    }
  }

  /**
   * 位置 → 房间 id
   */
  roomAt(position) {
    for (const room of this.rooms.values()) {
      if (room.bounds.containsPoint(position)) return room.id;
    }
    return null;
  }

  /**
   * 位置 → 该处应该接受的 SH（含门洞混合）。
   * @returns {Float32Array} 27 个数
   */
  shAt(position, out = this._sh) {
    const roomId = this.roomAt(position);
    if (roomId === null) {
      out.fill(0);
      return out;
    }

    const room = this.rooms.get(roomId);
    out.set(room.sh);

    for (const door of room.doors) {
      const neighbor = this.rooms.get(door.to);
      if (!neighbor) continue;

      const axis = door.axis === 'z' ? 'z' : 'x';
      const lateralAxis = axis === 'x' ? 'z' : 'x';

      const along = position[axis] - door.pos;
      const lateral = Math.abs(position[lateralAxis] - door.center);

      // 只在门洞的横向范围内才混合
      if (lateral > door.halfWidth * 2.2) continue;

      const dist = Math.abs(along);
      if (dist > door.blend) continue;

      const t =
        (1 - smoothstep(0, door.blend, dist)) *
        (1 - smoothstep(door.halfWidth, door.halfWidth * 2.2, lateral)) *
        0.85;

      if (t <= 0) continue;

      for (let i = 0; i < out.length; i++) {
        out[i] = out[i] * (1 - t) + neighbor.sh[i] * t;
      }
    }

    return out;
  }

  /**
   * 给一个物体绑定房间探针。
   * @param {THREE.Object3D} obj
   * @param {number} roomId  固定归属的房间（用于房间壳体）
   * @param {boolean} follow true = 每帧按物体当前位置重新算（含门洞混合）
   *                        false = 始终用 roomId 房间的 SH
   */
  bindObject(obj, roomId, follow = false) {
    const uniforms = createProbeUniforms(1);
    bindObjectProbe(obj, uniforms);
    this.bound.push({ obj, uniforms, roomId, follow });
    return uniforms;
  }

  /** 解绑（物体被移除时调用，避免 uniform 泄漏） */
  unbindObject(obj) {
    this.bound = this.bound.filter((b) => b.obj !== obj);
  }

  /**
   * 每帧回写：把当前 SH 写进每个绑定物体的 uniform。
   */
  update() {
    if (this.globalProbeMode) {
      for (const b of this.bound) b.uniforms.roomSHIntensityUniform.value = 0;
      return;
    }

    for (const b of this.bound) {
      let sh;
      if (b.follow) {
        b.obj.getWorldPosition(this._tmp);
        sh = this.shAt(this._tmp);
      } else {
        const room = this.rooms.get(b.roomId);
        sh = room ? room.sh : null;
      }
      if (!sh) continue;
      writeSH(b.uniforms.roomSHUniform, sh);
      b.uniforms.roomSHIntensityUniform.value = 1;
    }
  }

  /**
   * 全局探针模式（对照组）。
   * 打开后 per-material 注入被关掉，改由 scene 级 LightProbe 统一照明 —— 
   * 用来直观演示"场景级探针无法分房间"这件事。
   */
  setGlobalProbeMode(enabled) {
    this.globalProbeMode = enabled;
  }
}

/**
 * 构造一份 9×RGB 的 SH。带 0 是 DC，带 1 的 [1] 是 y 分量（可表达"从上方来的光"）。
 */
export function makeSH(dc, upFromAbove = 0, upColor = null) {
  const sh = new Float32Array(SH_COEFFS * SH_CHANNELS);
  sh[0] = dc[0];
  sh[1] = dc[1];
  sh[2] = dc[2];
  if (upFromAbove !== 0) {
    const c = upColor || dc;
    sh[3] = upFromAbove * c[0]; // 系数 1 = y
    sh[4] = upFromAbove * c[1];
    sh[5] = upFromAbove * c[2];
  }
  return sh;
}
