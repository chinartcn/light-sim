import * as THREE from 'three';

/**
 * 房间几何构建。
 *
 * 两个房间共享一堵墙，墙上开门洞 —— 门洞是：
 *   · 几何配准的天然特征
 *   · 光照混合带的中心
 *   · 遮挡边界
 *
 * 一个容易踩的坑：**共墙不能只用一张双面片**。
 * 一张双面片只能挂一个探针，从卧室看过去那面墙会被客厅的白色光照亮。
 * 正确做法是拆成两片单面片，各贴各房间的探针：
 *   客厅侧 x = -0.01，法线 -x
 *   卧室侧 x = +0.01，法线 +x
 * 这就是"结构层按房间分片"的具体含义。
 *
 * 每个房间占一个 layer：
 *   主相机在 layer 0（默认），两个房间都能看见；
 *   cube 相机用 layers.set(roomLayer) 渲染时只渲到该房间 —— 用于烘反射。
 *
 * 注意：three.js 的灯光是**全局**的（WebGLRenderer 里 lights 统一 pushLight，
 * 不做 per-object 过滤），所以"每个房间一盏灯"只能靠 distance 衰减近似，
 * 真正做到分区的是 per-material 的 SH 探针注入。
 */

export const LAYER_LIVING = 1;
export const LAYER_BEDROOM = 2;

const WALL_H = 3.2;
const DOOR_W = 1.8;
const DOOR_H = 2.1;
const WALL_T = 0.01; // 共墙两片之间的厚度

function makeMaterial(color = 0x9aa0a6) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.92,
    metalness: 0.0,
    // 单面：每面墙只从自己房间那一侧被看到
    side: THREE.FrontSide,
  });
}

/** 竖直墙：w 沿水平，h 沿高度，法线由 rotY 决定 */
function wall(w, h, pos, rotY, material) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  m.position.set(pos[0], pos[1], pos[2]);
  m.rotation.y = rotY;
  m.receiveShadow = true;
  return m;
}

/** 水平面：法线由 rotX 决定（-PI/2 → 朝上，PI/2 → 朝下） */
function slab(w, d, pos, rotX, material) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  m.position.set(pos[0], pos[1], pos[2]);
  m.rotation.x = rotX;
  m.receiveShadow = true;
  return m;
}

/**
 * 造一堵带门洞的墙（拆成左右两片 + 门楣）。
 * @param sideSign -1 = 法线朝 -x（客厅侧），+1 = 朝 +x（卧室侧）
 */
function wallWithDoor(sideSign, x, zCenter, zSpan, material) {
  const g = new THREE.Group();
  const sideW = (zSpan - DOOR_W) / 2;
  const rotY = sideSign > 0 ? Math.PI / 2 : -Math.PI / 2;
  const px = sideSign > 0 ? x + WALL_T : x - WALL_T;

  g.add(wall(sideW, WALL_H, [px, WALL_H / 2, zCenter - (DOOR_W / 2 + sideW / 2)], rotY, material));
  g.add(wall(sideW, WALL_H, [px, WALL_H / 2, zCenter + (DOOR_W / 2 + sideW / 2)], rotY, material));
  // 门楣
  g.add(
    wall(DOOR_W, WALL_H - DOOR_H, [px, DOOR_H + (WALL_H - DOOR_H) / 2, zCenter], rotY, material)
  );
  return g;
}

/**
 * @returns {{group: THREE.Group, rooms: Array, door: object}}
 */
export function buildRooms(scene) {
  const group = new THREE.Group();
  group.name = 'rooms';

  // 中性灰墙面 —— 房间的颜色**完全由探针决定**，
  // 这样才能看出"客厅白 / 卧室红"是探针的功劳，而不是贴图的功劳。
  //
  // 注意：每个房间用**独立**的材质实例。材质一旦被绑定到某个房间的 uniform，
  // 就不能被另一个房间共用，否则两间房的墙会吃到同一组 SH。
  const livingMat = makeMaterial(0x8d9196);
  const bedroomMat = makeMaterial(0x8d9196);
  const livingFloor = makeMaterial(0x6e7276);
  const livingCeil = makeMaterial(0xa8acb0);
  const bedroomFloor = makeMaterial(0x6e7276);
  const bedroomCeil = makeMaterial(0xa8acb0);

  // ---------- 客厅 x ∈ [-6, 0] ----------
  const living = new THREE.Group();
  living.name = 'living';
  living.add(slab(6, 8, [-3, 0, 0], -Math.PI / 2, livingFloor)); // 地面
  living.add(slab(6, 8, [-3, WALL_H, 0], Math.PI / 2, livingCeil)); // 天花
  living.add(wall(8, WALL_H, [-6, WALL_H / 2, 0], Math.PI / 2, livingMat)); // 西墙，法线 +x
  living.add(wall(6, WALL_H, [-3, WALL_H / 2, -4], 0, livingMat)); // 北墙，法线 +z
  living.add(wall(6, WALL_H, [-3, WALL_H / 2, 4], Math.PI, livingMat)); // 南墙，法线 -z
  // 共墙的客厅侧（法线 -x）
  living.add(wallWithDoor(-1, 0, 0, 8, livingMat));

  // ---------- 卧室 x ∈ [0, 6] ----------
  const bedroom = new THREE.Group();
  bedroom.name = 'bedroom';
  bedroom.add(slab(6, 8, [3, 0, 0], -Math.PI / 2, bedroomFloor));
  bedroom.add(slab(6, 8, [3, WALL_H, 0], Math.PI / 2, bedroomCeil));
  bedroom.add(wall(8, WALL_H, [6, WALL_H / 2, 0], -Math.PI / 2, bedroomMat)); // 东墙，法线 -x
  bedroom.add(wall(6, WALL_H, [3, WALL_H / 2, -4], 0, bedroomMat));
  bedroom.add(wall(6, WALL_H, [3, WALL_H / 2, 4], Math.PI, bedroomMat));
  // 共墙的卧室侧（法线 +x）
  bedroom.add(wallWithDoor(+1, 0, 0, 8, bedroomMat));

  for (const g of [living, bedroom]) group.add(g);

  // ---------- layer 分配 ----------
  const applyLayer = (obj, layer) => obj.traverse((o) => o.layers.enable(layer));
  applyLayer(living, LAYER_LIVING);
  applyLayer(bedroom, LAYER_BEDROOM);

  scene.add(group);

  const livingBounds = new THREE.Box3(
    new THREE.Vector3(-6, 0, -4),
    new THREE.Vector3(0.01, WALL_H, 4)
  );
  const bedroomBounds = new THREE.Box3(
    new THREE.Vector3(-0.01, 0, -4),
    new THREE.Vector3(6, WALL_H, 4)
  );

  return {
    group,
    rooms: [
      {
        id: 1,
        name: '客厅',
        layerId: LAYER_LIVING,
        group: living,
        center: new THREE.Vector3(-3, 1.6, 0),
        bounds: livingBounds,
        materials: [livingMat, livingFloor, livingCeil],
      },
      {
        id: 2,
        name: '卧室',
        layerId: LAYER_BEDROOM,
        group: bedroom,
        center: new THREE.Vector3(3, 1.6, 0),
        bounds: bedroomBounds,
        materials: [bedroomMat, bedroomFloor, bedroomCeil],
      },
    ],
    door: {
      axis: 'x',
      pos: 0,
      center: 0,
      halfWidth: DOOR_W / 2,
      blend: 1.6,
    },
  };
}

export { WALL_H, DOOR_W, DOOR_H };
