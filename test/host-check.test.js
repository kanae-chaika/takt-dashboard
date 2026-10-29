// 実行: node --test test/host-check.test.js
// Host ヘッダーの検証（Issue #1 の指摘 3。DNS rebinding の予防策）。
// bin/takt-dashboard を子プロセスで起動し、HTTP の応答で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
// fetch は Host ヘッダーを上書きできないので、node:http の request で headers.host を指定して送る。接続先は常に 127.0.0.1（listen 先）で、変えるのは Host ヘッダーだけ
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/takt-dashboard', import.meta.url));

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo');
const RUN = path.join(REPO, '.takt', 'runs', '20261029-100000-host');
const REPORT = 'host-check の plan レポート\n';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer() {
  let port = await freePort();
  while (port === 7331) port = await freePort(); // 既定ポートと同じだと「ポートを 7331 で固定した誤実装」を区別できない
  const env = { ...process.env, HOME };
  delete env.TAKT_DASHBOARD_ROOTS;
  delete env.TAKT_DASHBOARD_PORT;
  const child = spawn(process.execPath, [BIN, '--port', String(port)], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('takt-dashboard が起動しない: ' + stderr)), 10000);
      let stdout = ''; // 起動メッセージが複数の data に分かれても見つけられるよう、連結してから探す
      child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('takt-dashboard: http://localhost:')) { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('takt-dashboard が起動前に終了した (code ' + code + '): ' + stderr)); });
    });
  } catch (e) {
    await stopServer({ child }); // 起動待ちで失敗しても子プロセスを残さない（残るとテストが終わらない）
    throw e;
  }
  return { child, port };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return; // シグナルで終了済みなら exitCode は null のまま
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
}

// host が null のときは Host ヘッダーを付けずに送る（setHost: false）
function get(requestPath, host) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port: server.port, path: requestPath, method: 'GET', agent: false };
    if (host === null) opts.setHost = false;
    else opts.headers = { host };
    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function assertForbidden(res) {
  assert.equal(res.status, 403);
  assert.equal(res.type, 'text/plain; charset=utf-8');
  assert.equal(res.body, 'forbidden');
}

let server;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(RUN, 'reports'), { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）
  fs.writeFileSync(path.join(RUN, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: '20261029-100000-host', currentStep: 'plan', startTime: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z' }));
  fs.writeFileSync(path.join(RUN, 'reports', 'plan.md'), REPORT);
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('C-HOST-DENY: Host: evil.example は 403 forbidden', async () => {
  assertForbidden(await get('/api/state', 'evil.example'));
});

test('C-HOST-DENY: Host: evil.example:<PORT> は 403 forbidden', async () => {
  assertForbidden(await get('/api/state', 'evil.example:' + server.port));
});

test('C-HOST-DENY: 偽の Host はすべてのエンドポイントで 403 forbidden', async () => {
  const host = 'evil.example:' + server.port;
  for (const p of ['/api/state', '/api/report?p=plan.md', '/', '/takt-logo.svg']) {
    assertForbidden(await get(p, host));
  }
});

test('C-HOST-DENY: 許可名を前方・後方に含むだけの Host は 403 forbidden（完全一致で判定する）', async () => {
  for (const host of ['localhost.evil.example:' + server.port, 'evil-localhost:' + server.port, '127.0.0.1.evil.example', 'localhost:' + server.port + '.evil.example']) {
    assertForbidden(await get('/api/state', host));
  }
});

test('C-HOST-DENY: 許可名でも listen していないポートの Host は 403 forbidden', async () => {
  for (const host of ['localhost:7331', '127.0.0.1:' + (server.port + 1), '[::1]:1']) {
    assertForbidden(await get('/api/state', host));
  }
});

test('C-HOST-MISSING: Host ヘッダーが無い要求は 403 forbidden', async () => {
  assertForbidden(await get('/api/state', null));
});

test('C-HOST-ALLOW: localhost:<PORT>・127.0.0.1:<PORT>・[::1]:<PORT> は 200', async () => {
  for (const host of ['localhost:' + server.port, '127.0.0.1:' + server.port, '[::1]:' + server.port]) {
    const res = await get('/api/state', host);
    assert.equal(res.status, 200, host);
    assert.equal(res.type, 'application/json', host);
    assert.equal(JSON.parse(res.body).active.runDir, RUN, host);
  }
});

test('C-HOST-ALLOW: ポート無しの localhost・127.0.0.1・[::1] は 200', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const res = await get('/api/state', host);
    assert.equal(res.status, 200, host);
  }
});

test('C-HOST-ALLOW: Host の大文字小文字は区別しない', async () => {
  for (const host of ['LOCALHOST:' + server.port, 'LocalHost']) {
    const res = await get('/api/state', host);
    assert.equal(res.status, 200, host);
  }
});

test('K-NORMAL: 許可された Host ではレポート・HTML も従来どおり返る', async () => {
  const host = 'localhost:' + server.port;
  const report = await get('/api/report?p=plan.md', host);
  assert.equal(report.status, 200);
  assert.equal(report.type, 'text/plain; charset=utf-8');
  assert.equal(report.body, REPORT);
  const html = await get('/', host);
  assert.equal(html.status, 200);
  assert.equal(html.type, 'text/html; charset=utf-8');
});
