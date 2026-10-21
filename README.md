# Room Sim — 分房间的 3D 沙盒编辑器

> 从 light-sim 演进而来：把"全局一份 SH 探针"改成"**按房间分组**的探针"，
> 并为低配设备浏览器准备了一套分档渲染管线。

基于 Vite + Three.js + Node.js (WebSocket) 构建的高性能 3D 沙盒编辑器。

## 🚀 核心特性

- **渲染引擎**：Three.js + WebGL，PBR 材质、SSAO、HDR 天空、镜面反射。
- **分房间光影**：后端通过 WebSocket 推送**按房间分组**的低频全局光 (SH 球谐函数)，
  前端按物体所在位置选取对应房间的探针。
- **门洞过渡带**：两个房间的墙之间存在混合带，靠近门口时两个房间的光会互相渗透。
- **模型交互**：多模型加载、拖放、极速克隆 (SkeletonUtils)、自动居中和包围盒计算。
- **低配适配**：自动探测设备能力并分档（高/中/低），手动可覆盖。
- **移动端适配**：横向工具栏、虚拟摇杆、长按升降按钮。
- **自动化工具**：集成 `@rtcn/tred` (AST 重构引擎) 与 Vite 插件。

## 🛠️ 快速启动

```bash
npm install
npm run dev
```

客户端 `http://localhost:5173`，WebSocket 服务 `ws://localhost:4443`。

```bash
npm test        # 房间归属 / 门洞混合 / shader 注入点 / 协议往返，共 27 项
npm run build
```

## 🎬 怎么看这个 demo

1. 打开后相机在**客厅**（白色冷光），顶部显示 `📍 客厅`。
2. 用摇杆/方向键穿过门洞进**卧室** —— 墙变成红色氛围灯。
3. 从客厅回头看门框，卧室是红的、客厅是白的，**同一帧里两种光共存**。
4. 从模型列表拖个模型进卧室，它会跟着变红 —— 探针是按物体位置取的。
5. 打开工具台 → **「🌐 全局探针(对比)」**，看反面：
   scene 级 LightProbe 会把两个房间的 SH **累加**进同一组 9 个系数，
   全场景只剩一个中间色，房间彻底串色。
6. 工具台 → **「⚙️ 质量档」** 切到「低」，观察 pixelRatio 掉到 1、后期绕开 composer。

---

## 🧩 架构

### 为什么场景级 LightProbe 做不到分房间

three.js `WebGLLights.js:254`：

```js
} else if ( light.isLightProbe ) {
    for ( let j = 0; j < 9; j ++ ) {
        state.probe[ j ].addScaledVector( light.sh.coefficients[ j ], intensity );
    }
}
```

所有 LightProbe 被**累加**进同一份 `state.probe`，最终只有一组
`uniform vec3 lightProbe[9]` 作用于全场景（`WebGLRenderer.js:1716`）。
场景级探针没有空间概念 —— 客厅白 + 卧室红只会被加成一团中间色。

### 解法：per-material 注入

绕开 scene 级探针，直接给材质注入一组 `uRoomSH`：

```glsl
// 在 #include <lights_fragment_begin> 之后
irradiance += shGetIrradianceAt(
  inverseTransformDirection( geometryNormal, viewMatrix ),
  uRoomSH
) * uRoomSHIntensity;
```

`shGetIrradianceAt` 定义在 `lights_pars_begin` 中且**不在** `USE_LIGHT_PROBES`
守卫内，所以不挂任何 LightProbe 也能用它的数学。

实现见 `client/src/scene/room-probe-material.js`。

> ⚠️ uniform 容器**不能**放在 `material.userData` 里 ——
> `Material.copy()` 用 `JSON.parse(JSON.stringify(userData))` 做深拷贝，
> `THREE.Vector3` 会被拷成普通对象，`.set()` 直接失效。这里用 `WeakMap`。

### 分层

| 层 | 内容 | 运行时行为 |
|---|---|---|
| 结构层 | 墙/地/顶，按房间分片 | 静态，探针直接挂在材质上 |
| 探针层 | 每房间一组 SH (27 个数) | 房间内固定，门洞处混合 |
| 物体层 | 可替换模型 | 每帧按位置取 SH（`follow=true`） |
| 反射层 | 每房间一张 cubemap | per-material `envMap` |

**共墙必须拆成两片**（客厅侧 `x=-0.01` 法线 -x，卧室侧 `x=+0.01` 法线 +x）——
一张双面片只能挂一个探针，从卧室看过去那面墙会被客厅的白光照亮。

### 门洞过渡带

`RoomRegistry.shAt(position)`：

- 找到位置所属房间 → 取该房间的 SH
- 对每个门洞：算沿墙距离 + 横向偏移，`smoothstep` 衰减后与邻居房间的 SH 插值
- 横向超出 `halfWidth * 2.2` 的墙边不参与混合

所以站在客厅靠近门口，客厅的墙已经开始吃到卧室的红。

### 灯光的另一个坑

three.js 的灯光是**全局**的 —— `WebGLRenderer` 里 lights 统一 `pushLight`，
不做 per-object 过滤，所以**灯光不支持 layer 分区**。
每个房间一盏灯只能靠 `distance` 衰减来近似；真正做到分区的是探针。

---

## 📡 协议 v1

### SH 帧（type = 0）

```
[0]      type: u8 = 0
[1..4]   frameId: u32
[5..12]  timestamp: f64
[13..14] roomCount: u16
每房间:
  [0..1]  roomId: u16
  [2..]   sh: 27 × f32   (9 系数 × RGB，顺序同 three.js SphericalHarmonics3)
```

### 房间清单（type = 2）

```
[0]      type: u8 = 2
[1..2]   roomCount: u16
每房间:
  [0..1]  roomId: u16
  [2]     nameLen: u8
  [3..]   name: utf8
```

相比 v0 的变化：SH 从"全局一份 9 个标量"变成"**每房间一份 27 个 RGB 系数**"。
这是多房间场景的前提。频率 4Hz（房间光照是静态的；实时编辑会话才需要更高）。

---

## 📦 场景清单（可分享格式）

「💾 保存布局」导出的就是这个：

```json
{
  "version": 2,
  "rooms": [
    { "id": 1, "name": "客厅", "sh": [ ...27 个数... ] }
  ],
  "slots": [
    {
      "slotId": "s_00",
      "assetId": "/models/Parrot.glb",
      "roomId": 1,
      "transform": { "position": [...], "rotation": [...], "scale": [...] }
    }
  ]
}
```

**房间/光照和物体清单是分开的** —— 改动物体不会污染房间，
这就是"别人改了你的场景但不破坏原作"的基础。

---

## 📉 低配设备预算

原则：**管线开关一个都不砍，但静态的东西不在运行时算。**

| 档 | pixelRatio | 后期 | SSAO | 阴影 | 反射 |
|---|---|---|---|---|---|
| 高 | min(dpr,2) | EffectComposer | 全分辨率 | 1024 PCFSoft | 256 |
| 中 | min(dpr,1.5) | EffectComposer | **半分辨率** | 512 PCF | 128 |
| 低 | **1.0** | **绕开 composer** | 半分辨率 | 512 Basic | 64 |

- 探测：`navigator.hardwareConcurrency` + `navigator.deviceMemory` + WebGL2 + 移动端标记，
  三项投票；另有运行时 FPS 看门狗（连续掉帧降一档，只降不升）。
- `SSAOPass` 内部会 `renderOverride()` 多渲一遍全场景取法线+深度，是最贵的一步。
  `ScaledSSAOPass` 把它压到半分辨率，最后由 composer 放大回画布。
- `renderer.setPixelRatio(1)` 是低端机收益最大的一条（3x 屏 = 9 倍像素量）。
- 反射从 `scene.environment`（全局）改成 per-material `envMap`，
  否则卧室的墙会反射出客厅的环境色。
- 静态房间的 AO / 静态阴影 / 环境反射，目标是**发布时烘进房间包**，运行时直接读。

---

## 📂 目录

```
server/index.js              SH 推送服务（按房间分组）
client/src/
  main.js                    场景装配 / 交互 / 渲染循环
  network/light-sync.js      协议 v1 客户端 + 插值
  scene/room-registry.js     房间注册表：归属判定 / 门洞混合 / 探针回写
  scene/room-probe-material.js  per-material SH 注入
  scene/room-builder.js      房间几何（共墙分两片）
  utils/quality-tier.js      设备探测 + 分档
  utils/post-processing.js   分档后期
  utils/reflection.js        per-room 反射探针
test/verify.mjs              房间 / 混合 / shader 注入点
test/protocol.mjs            协议往返
```

## 🛠️ 下一步

- [ ] 房间包（几何 + lightmap + 烘焙 env）发布流程
- [ ] 槽位语义约束（换进来的模型要同类、同尺度、自动吸附地面）
- [ ] 门洞 joint capture → 跨房间配准
- [ ] 派生版本：别人改了你的场景 → 生成新版本，不污染原件
