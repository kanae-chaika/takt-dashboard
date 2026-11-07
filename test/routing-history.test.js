// 実行: node --test test/routing-history.test.js
// 並列の子の provider / model を run 開始時点の設定から引く経路（routingFor）を確かめる。
// - ~/.takt の runtime.yaml.bak-*: mtime は「その内容が置き換えられた時刻」なので、mtime が run 開始より後のもののうち最も早いものが当時の設定
// - runtime.yaml が無いとき: 旧形式の config.yaml（provider_routing.steps）を読み、それも無ければ既定の claude・model なし
// ~/.takt の中身がケースごとに違うので、ケースごとに HOME とサーバーを分ける（HOME はサーバーの起動時に決まる）。
// PATH を空にして手元の takt 本体を読ませない
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const START = '2026-11-01T10:00:00.000Z';
const at = (sec) => new Date(Date.parse(START) + sec * 1000).toISOString();
const HOUR = 3600;

// 既存のパーサー（loadRuntimeRouting）が読める形: 先頭が provider:、profiles は 4 字下げ
const runtimeYaml = (provider, model) => `provider:
  defaults:
    profile: base
  profiles:
    base: { provider: ${provider}, model: ${model} }
`;

// HOME と repo を一時ディレクトリに作り、ファイルの全テストの後に消す。
// t.after は登録順に走るので、テストごとに消すとサーバー（cwd がこの中）を止める前に消すことになる（Windows では使用中の cwd を消せない）
const sandboxes = [];
after(() => { for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true }); });
function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-routing-')));
  sandboxes.push(root);
  const home = path.join(root, 'home'), repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(home, '.takt'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.takt', 'runs'), { recursive: true });
  return { home, repo };
}

// 親 reviewers の下で並列の子 subs を 1 回ずつ実行した run（並列の子の行は step_start の無い step の phase_start(execute) から作られる）。
// meta.json に workflow は入れない（並列の子の tag を workflow yaml から引く経路に入れないため）
function writeRun(repo, slug, startTime, subs) {
  const runDir = path.join(repo, '.takt', 'runs', slug);
  const t0 = Date.parse(startTime);
  const ts = (sec) => new Date(t0 + sec * 1000).toISOString();
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'reviewers', startTime, updatedAt: ts(60) }));
  const events = [{ type: 'step_start', step: 'reviewers', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: ts(1) }];
  subs.forEach((step, i) => events.push({ type: 'phase_start', step, iteration: 1, phaseName: 'execute', timestamp: ts(2 + i) }));
  fs.writeFileSync(path.join(runDir, 'logs', 'run.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return runDir;
}

async function start(t, { home, repo }) {
  const s = await startDashboard({ cwd: repo, home, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '' } });
  t.after(() => stopDashboard(s));
  return s;
}

// 並列の子の行の provider / model / source
async function subPm(s, runDir, step) {
  const res = await fetch(s.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.timeline.find((r) => r.kind === 'sub' && r.step === step);
  assert.ok(row, step + ' の並列の子の行がある');
  return { provider: row.provider, model: row.model, source: row.source };
}

const readSnap = (home, runDir) => JSON.parse(fs.readFileSync(path.join(home, '.config', 'takt-dashboard', 'routing', path.basename(runDir) + '.json'), 'utf8'));

// ---------- runtime.yaml.bak-* の選び方 ----------

// 置き換えの履歴: A（〜開始の 1 時間前）→ B（〜開始の 1 時間後）→ C（現在の runtime.yaml）
function setupBackups() {
  const box = makeSandbox();
  const dir = path.join(box.home, '.takt');
  const put = (name, provider, model, mtime) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, runtimeYaml(provider, model));
    if (mtime) { const d = new Date(mtime); fs.utimesSync(p, d, d); }
  };
  put('runtime.yaml.bak-old', 'codex', 'gpt-a', at(-HOUR));
  put('runtime.yaml.bak-new', 'opencode', 'big-b', at(HOUR));
  put('runtime.yaml', 'claude', 'current-c');
  return box;
}

test('2 つの runtime.yaml.bak-* の mtime の間に始まった run の並列の子は、後の .bak の設定で表示される', async (t) => {
  // Given: bak-old の mtime（開始の 1 時間前）と bak-new の mtime（開始の 1 時間後）の間に始まった run
  const box = setupBackups();
  const runDir = writeRun(box.repo, '20261101-100000-between', START, ['arch-review']);
  const s = await start(t, box);

  // When / Then: 現在の runtime.yaml（C）でも前の bak-old（A）でもなく、bak-new（B）の provider / model になる
  assert.deepEqual(await subPm(s, runDir, 'arch-review'), { provider: 'opencode', model: 'big-b', source: 'runtime.yaml.bak-new' });
});

test('runtime.yaml.bak-* から選んだ設定は ~/.config/takt-dashboard/routing/<run>.json の控えに書かれる', async (t) => {
  // Given: 前のテストと同じ履歴で、bak の間に始まった run
  const box = setupBackups();
  const runDir = writeRun(box.repo, '20261101-100000-snap', START, ['arch-review']);
  const s = await start(t, box);

  // When: 初めて表示する
  await subPm(s, runDir, 'arch-review');

  // Then: 控えに bak-new の内容と出どころが書かれている（以後 yaml を変えても表示が変わらないように）
  const snap = readSnap(box.home, runDir);
  assert.equal(snap.source, 'runtime.yaml.bak-new');
  assert.deepEqual(snap.def, { provider: 'opencode', model: 'big-b' });
});

test('どちらの runtime.yaml.bak-* よりも前に始まった run は、mtime が最も早い .bak の設定で表示される', async (t) => {
  // Given: bak-old の mtime よりさらに 1 時間前に始まった run（開始より後の .bak は old と new の 2 つ）
  const box = setupBackups();
  const runDir = writeRun(box.repo, '20261101-080000-before', at(-2 * HOUR), ['arch-review']);
  const s = await start(t, box);

  // When / Then: 開始より後のもののうち最も早い bak-old（A）。最も新しい .bak を選ぶ実装なら B になる
  assert.deepEqual(await subPm(s, runDir, 'arch-review'), { provider: 'codex', model: 'gpt-a', source: 'runtime.yaml.bak-old' });
});

// ---------- runtime.yaml が無いとき ----------

test('runtime.yaml が無く旧形式の config.yaml だけがあるとき、並列の子は config.yaml の provider_routing.steps と最上位の provider / model で表示される', async (t) => {
  // Given: ~/.takt に config.yaml だけ。arch-review は steps で名指し、flow-review は名指しなし
  const box = makeSandbox();
  fs.writeFileSync(path.join(box.home, '.takt', 'config.yaml'), `# 旧形式の設定
provider: codex
model: gpt-5
provider_routing:
  steps:
    arch-review: { provider: opencode, model: big }
`);
  const runDir = writeRun(box.repo, '20261101-100000-config', START, ['arch-review', 'flow-review']);
  const s = await start(t, box);

  // When / Then: 名指しの子は steps の値、それ以外は最上位の provider / model。出どころは config.yaml
  assert.deepEqual(await subPm(s, runDir, 'arch-review'), { provider: 'opencode', model: 'big', source: 'config.yaml' });
  assert.deepEqual(await subPm(s, runDir, 'flow-review'), { provider: 'codex', model: 'gpt-5', source: 'config.yaml' });
});

test('runtime.yaml も config.yaml も無いとき、並列の子は既定の claude・model なしで表示される', async (t) => {
  // Given: ~/.takt は空
  const box = makeSandbox();
  const runDir = writeRun(box.repo, '20261101-100000-none', START, ['arch-review']);
  const s = await start(t, box);

  // When / Then: 200 で、既定の claude・model なし。出どころは config（ファイルが無いときの既定）
  assert.deepEqual(await subPm(s, runDir, 'arch-review'), { provider: 'claude', model: null, source: 'config' });
});
