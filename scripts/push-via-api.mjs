#!/usr/bin/env node
/**
 * 通过 GitHub REST API 推送（绕开本沙箱里挂起的 git-remote-https 协议）。
 *
 * 为什么需要这个：本沙箱的 git 走 https 时，`git push` 会卡在 git-remote-https
 * 不返回（`git ls-remote` 却正常）。而 GitHub REST API 走 Node fetch 完全正常，
 * 所以改用 API 直接建 blob → tree → commit → ref → PR。
 *
 * token 只从环境变量读，不写盘、不进 git config、不进 remote URL。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/push-via-api.mjs
 *   GH_TOKEN=xxx GH_BRANCH=feat/xxx GH_REPO=owner/repo node scripts/push-via-api.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.GH_TOKEN;
const REPO = process.env.GH_REPO || 'chinartcn/light-sim';
const BASE = process.env.GH_BASE || 'origin/main';
const BRANCH = process.env.GH_BRANCH || 'feat/room-probe';
const API = `https://api.github.com/repos/${REPO}`;

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'mavis-room-sim',
  'Content-Type': 'application/json',
};

async function api(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  return json;
}

const git = (...args) =>
  execSync(
    `git ${args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')}`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  ).trim();

console.log(`→ repo=${REPO} base=${BASE} branch=${BRANCH}`);

const baseSha = git('rev-parse', BASE);
const baseTree = git('rev-parse', `${BASE}^{tree}`);
console.log(`  base commit ${baseSha.slice(0, 8)}  tree ${baseTree.slice(0, 8)}`);

const nameStatus = git('diff', '--name-status', BASE, 'HEAD');
const changes = nameStatus
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, path] = line.split('\t');
    return { status, path };
  });

console.log(`  ${changes.length} 个文件变更`);

const entries = [];
for (const { status, path } of changes) {
  if (status === 'D') {
    entries.push({ path, mode: '100644', type: 'blob', sha: null });
    continue;
  }
  const content = readFileSync(path);
  const blob = await api('/git/blobs', 'POST', {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  let mode = '100644';
  try {
    const ls = git('ls-tree', BASE, '--', path);
    const m = ls.match(/\d+ (\w+)\t/);
    if (m && m[1] !== 'blob') mode = m[1];
  } catch {}
  entries.push({ path, mode, type: 'blob', sha: blob.sha });
  console.log(`  · ${path}`);
}

const tree = await api('/git/trees', 'POST', {
  base_tree: baseTree,
  tree: entries,
});
console.log(`  新 tree ${tree.sha.slice(0, 8)}`);

const message = `feat: 分房间 SH 探针 + 低配质量档 + 可分享场景清单

核心：把"全局一份 SH 探针"改成"按房间分组"。

- per-material SH 注入：绕开 scene 级 LightProbe
  （WebGLLights 会把多个探针累加进同一组 9 个系数，全场景只有一个值，
   没有空间概念，客厅白+卧室红只会被加成中间色）
  注入点 #include <lights_fragment_begin> 之后，
  shGetIrradianceAt 不在 USE_LIGHT_PROBES 守卫内，不挂探针也能用
- uniform 容器用 WeakMap 而非 material.userData
  （Material.copy() 用 JSON 深拷贝，会把 Vector3 拷成普通对象）
- 门洞过渡带：RoomRegistry.shAt() 按沿墙距离 + 横向偏移 smoothstep 混合
- 共墙拆成两片单面片，各贴各房间的探针（一张双面片挂不了两个探针）
- 反射从 scene.environment 改为 per-material envMap，每房间一张 cubemap
- 质量档：设备探测 + FPS 看门狗；SSAO 半分辨率；低档绕开 composer
- 接触阴影贴片替代部分 SSAO
- 协议 v1：SH 从全局 9 标量 → 每房间 27 个 RGB 系数
- 场景清单 v2：rooms 与 slots 分离，可分享、可派生
- 新增 27 项测试（房间归属 / 门洞混合 / shader 注入点 / 协议往返）

Co-Authored-By: Mavis <mavis@local>`;

const commit = await api('/git/commits', 'POST', {
  message,
  tree: tree.sha,
  parents: [baseSha],
});
console.log(`  新 commit ${commit.sha.slice(0, 8)}`);

let created = true;
try {
  await api('/git/refs', 'POST', {
    ref: `refs/heads/${BRANCH}`,
    sha: commit.sha,
  });
} catch (e) {
  if (!String(e.message).includes('already exists')) throw e;
  created = false;
  await api(`/git/refs/heads/${BRANCH}`, 'PATCH', {
    sha: commit.sha,
    force: true,
  });
}
console.log(`  ${created ? '已创建' : '已更新'}分支 ${BRANCH}`);

try {
  const pr = await api('/pulls', 'POST', {
    title: 'feat: 分房间 SH 探针 + 低配质量档 + 可分享场景清单',
    head: BRANCH,
    base: 'main',
    body: `把"全局一份 SH 探针"改成"按房间分组"。

**核心**：three.js 的 \`WebGLLights\` 会把所有 LightProbe 累加进同一组 9 个系数，
全场景只有一个值 —— 场景级探针没有空间概念，客厅白 + 卧室红只会被加成中间色。
解法是 per-material 注入 \`uRoomSH\`，注入点 \`#include <lights_fragment_begin>\` 之后。

**顺带修掉的几处**：
- uniform 容器改用 WeakMap（\`Material.copy()\` 用 JSON 深拷贝，会毁掉 Vector3）
- 共墙拆成两片单面片，各贴各房间的探针
- 反射从 \`scene.environment\` 改为 per-material \`envMap\`
- 门洞过渡带：按沿墙距离 + 横向偏移 smoothstep 混合
- 低配质量档：SSAO 半分辨率、低档绕开 composer、pixelRatio 1.0

**验证**：27 项测试（房间归属 / 门洞混合 / shader 注入点 / 协议往返）全绿，build 通过。`,
  });
  console.log(`  PR #${pr.number}: ${pr.html_url}`);
} catch (e) {
  if (String(e.message).includes('already exists')) {
    console.log('  PR 已存在');
  } else {
    throw e;
  }
}

console.log('\n✅ 完成');
console.log(`   https://github.com/${REPO}/tree/${BRANCH}`);
