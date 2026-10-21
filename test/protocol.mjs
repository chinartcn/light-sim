/**
 * 服务端协议往返测试：真的起一个 server，用真的 WS 客户端连上去，
 * 解析二进制帧，验证房间清单和 SH 帧。
 *
 * 用法：node test/protocol.mjs
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 4455;
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stderr.on('data', (d) => console.error('[server err]', d.toString()));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const ws = new WebSocket(`ws://localhost:${PORT}`);
      // 监听器必须在连接建立**之前**挂上，
      // 否则房间清单帧（连接瞬间推送）会被丢掉
      const frames = [];
      ws.on('message', (data) => {
        frames.push(data instanceof Buffer ? data : Buffer.from(data));
      });
      await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      return { ws, frames };
    } catch (e) {
      await sleep(100);
    }
  }
  throw new Error('服务器没起来');
}

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const { ws, frames } = await waitForServer();

await sleep(600);

// --- 房间清单 ---
const listFrame = frames.find((f) => f.readUInt8(0) === 2);
console.log('\n[1] 房间清单帧');
ok('收到房间清单帧', () => assert.ok(listFrame, '没收到 type=2'));
ok('房间数量 = 2', () => assert.equal(listFrame.readUInt16LE(1), 2));

let offset = 3;
const names = [];
for (let i = 0; i < 2; i++) {
  const id = listFrame.readUInt16LE(offset);
  offset += 2;
  const len = listFrame.readUInt8(offset);
  offset += 1;
  names.push({ id, name: listFrame.subarray(offset, offset + len).toString('utf8') });
  offset += len;
}
ok('房间 1 = 客厅', () => assert.deepEqual(names[0], { id: 1, name: '客厅' }));
ok('房间 2 = 卧室', () => assert.deepEqual(names[1], { id: 2, name: '卧室' }));

// --- SH 帧 ---
const shFrame = frames.find((f) => f.readUInt8(0) === 0);
console.log('\n[2] SH 帧');
ok('收到 SH 帧', () => assert.ok(shFrame, '没收到 type=0'));
ok('帧长度 = 15 + 2*(2+27*4) = 233', () => assert.equal(shFrame.length, 15 + 2 * (2 + 27 * 4)));
ok('roomCount = 2', () => assert.equal(shFrame.readUInt16LE(13), 2));

function readRoomSH(frame, index) {
  let off = 15;
  for (let i = 0; i < index; i++) off += 2 + 27 * 4;
  const id = frame.readUInt16LE(off);
  off += 2;
  const sh = [];
  for (let k = 0; k < 27; k++) sh.push(frame.readFloatLE(off + k * 4));
  return { id, sh };
}

const living = readRoomSH(shFrame, 0);
const bedroom = readRoomSH(shFrame, 1);

ok('第一个是客厅 (id=1)', () => assert.equal(living.id, 1));
ok('第二个是卧室 (id=2)', () => assert.equal(bedroom.id, 2));
ok('客厅 SH 是白色（DC 三个通道都高）', () => {
  assert.ok(living.sh[0] > 0.5, `R=${living.sh[0]}`);
  assert.ok(living.sh[1] > 0.5, `G=${living.sh[1]}`);
  assert.ok(living.sh[2] > 0.5, `B=${living.sh[2]}`);
});
ok('卧室 SH 是红色（DC 只有 R 高）', () => {
  assert.ok(bedroom.sh[0] > 0.4, `R=${bedroom.sh[0]}`);
  assert.ok(bedroom.sh[1] < 0.2, `G=${bedroom.sh[1]}`);
  assert.ok(bedroom.sh[2] < 0.2, `B=${bedroom.sh[2]}`);
});
ok('两间房的 SH 确实不同（说明是分组而不是全局一份）', () => {
  assert.ok(Math.abs(living.sh[0] - bedroom.sh[0]) > 0.1);
});

// --- 帧率 ---
console.log('\n[3] 推送频率');
const shCount = frames.filter((f) => f.readUInt8(0) === 0).length;
ok('~600ms 内至少推了 1 帧 SH（4Hz）', () => assert.ok(shCount >= 1, `收到 ${shCount} 帧`));
console.log(`    实测 ${shCount} 帧 / ~600ms`);

ws.close();
server.kill();
console.log(`\n通过 ${passed} 项检查`);
process.exit(process.exitCode || 0);
