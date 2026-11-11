// 実行: node --test test/takt-config-dir.test.js
// takt の設定ディレクトリを takt と同じ決め方で選ぶことを確かめる
// （takt 0.74.0 の dist/infra/config/paths.js の getGlobalConfigDir: 環境変数 TAKT_CONFIG_DIR が空でなければそれ、無ければ ~/.takt）。
// 設定ディレクトリから読むもの: runtime.yaml（無ければ config.yaml）・そのバックアップ・workflows/・state/projects/<id>/runs（takt ui の run）。
// 取り違えが分かるよう、~/.takt と TAKT_CONFIG_DIR の両方に内容の違うものを置く。
// 設定ディレクトリはサーバーの起動時に決まるので、ケースごとにサーバーを分ける。PATH を空にして手元の takt 本体を読ませない
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

const START = '2026-11-01T10:00:00.000Z';
const at = (sec) => new Date(Date.parse(START) + sec * 1000).toISOString();
const HOUR = 3600;

// 既存のパーサー（loadRuntimeRouting）が読める形: 先頭が provider:、profiles は 4 字下げ、targets の tags の下は 6 字下げ
const runtimeYaml = (provider, model) => `provider:
  defaults:
    profile: base
  profiles:
    base: { provider: ${provider}, model: ${model} }
    rev: { provider: ${provider}, model: ${model}-review }
  targets:
    tags:
      review: { profile: rev }
`;
// 並列の子のうち tagged にだけ tag を付けた workflow yaml。tag は workflow yaml から引くので、設定ディレクトリごとに tag を付ける子を変えておくと、
// workflows/ をどちらから読んだかが分かる（TAKT_CONFIG_DIR 側は custom-tagged-review、~/.takt 側は home-tagged-review）
const SUBS = ['custom-tagged-review', 'home-tagged-review'];
const workflowYaml = (tagged) => `name: cfgwf
steps:
  - name: reviewers
    parallel:
      fixed:
${SUBS.map((name) => '        - name: ' + name + (name === tagged ? '\n          tags: [review]' : '')).join('\n')}
`;

// 親 reviewers の下で並列の子を 1 回ずつ実行した run
function writeRun(runDir, { workflow, task } = {}) {
  const slug = path.basename(runDir);
  fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'reviewers', startTime: START, updatedAt: at(300), ...(task ? { task } : {}) }));
  const events = [{ type: 'step_start', step: 'reviewers', iteration: 1, provider: 'claude', model: 'sonnet', timestamp: at(1) }];
  for (const step of SUBS) events.push({ type: 'phase_start', step, iteration: 1, phaseName: 'execute', timestamp: at(2), ...(workflow ? { workflow } : {}) });
  fs.writeFileSync(path.join(runDir, 'logs', 'session-1.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return runDir;
}

// takt の設定ディレクトリ 1 つ分: runtime.yaml・workflows/cfgwf.yaml・takt ui の run（state/projects/p1/runs/<slug>）
function writeTaktDir(dir, { provider, model, tagged, uiSlug }) {
  fs.mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.yaml'), runtimeYaml(provider, model));
  fs.writeFileSync(path.join(dir, 'workflows', 'cfgwf.yaml'), workflowYaml(tagged));
  return writeRun(path.join(dir, 'state', 'projects', 'p1', 'runs', uiSlug), { task: '# ' + uiSlug });
}

// HOME・TAKT_CONFIG_DIR にするディレクトリ・repo を一時ディレクトリに作り、ファイルの全テストの後に消す
// （t.after は登録順に走るので、テストごとに消すとサーバー（cwd がこの中）を止める前に消すことになる）
const sandboxes = [];
after(() => { for (const d of sandboxes) fs.rmSync(d, { recursive: true, force: true }); });
function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-cfgdir-')));
  sandboxes.push(root);
  const home = path.join(root, 'home'), repo = path.join(root, 'repo'), custom = path.join(root, 'custom-takt');
  const homeUi = writeTaktDir(path.join(home, '.takt'), { provider: 'opencode', model: 'home', tagged: 'home-tagged-review', uiSlug: '20261101-100000-home-ui' });
  const customUi = writeTaktDir(custom, { provider: 'codex', model: 'custom', tagged: 'custom-tagged-review', uiSlug: '20261101-100000-custom-ui' });
  const run = writeRun(path.join(repo, '.takt', 'runs', '20261101-100000-cli'), { workflow: 'cfgwf' });
  return { home, repo, custom, homeUi, customUi, run };
}

async function start(t, box, env) {
  const s = await startDashboard({ cwd: box.repo, home: box.home, env: { PATH: '', TAKT_DASHBOARD_ROOTS: '', ...env } });
  t.after(() => stopDashboard(s));
  return s;
}

async function getState(s, runDir) {
  const res = await fetch(s.base + '/api/state?run=' + encodeURIComponent(runDir));
  assert.equal(res.status, 200);
  return res.json();
}
// 並列の子の provider / model（step 名 → { provider, model }）
function subs(body) {
  const out = {};
  for (const r of body.timeline.filter((r) => r.kind === 'sub')) out[r.step] = { provider: r.provider, model: r.model };
  return out;
}

test('CFGDIR-SET: TAKT_CONFIG_DIR があれば、そこの runtime.yaml・workflows・takt ui の run を読み、~/.takt のものは読まない', async (t) => {
  const box = makeSandbox();
  const s = await start(t, box, { TAKT_CONFIG_DIR: box.custom });
  const body = await getState(s, box.run);
  assert.deepEqual(subs(body), {
    'custom-tagged-review': { provider: 'codex', model: 'custom-review' },
    'home-tagged-review': { provider: 'codex', model: 'custom' },
  });
  const listed = body.runs.map((r) => r.runDir);
  assert.ok(listed.includes(box.customUi), 'TAKT_CONFIG_DIR の takt ui の run が一覧にある');
  assert.ok(!listed.includes(box.homeUi), '~/.takt の takt ui の run は一覧に無い');
  // takt ui の run として扱う（設定ディレクトリの state/projects 配下かどうかで判定している）
  assert.match(body.runs.find((r) => r.runDir === box.customUi).label, /^UI: /);
});

test('CFGDIR-UNSET: TAKT_CONFIG_DIR が無ければ ~/.takt を読む', async (t) => {
  const box = makeSandbox();
  const s = await start(t, box, {});
  const body = await getState(s, box.run);
  assert.deepEqual(subs(body), {
    'custom-tagged-review': { provider: 'opencode', model: 'home' },
    'home-tagged-review': { provider: 'opencode', model: 'home-review' },
  });
  const listed = body.runs.map((r) => r.runDir);
  assert.ok(listed.includes(box.homeUi));
  assert.ok(!listed.includes(box.customUi));
});

test('CFGDIR-EMPTY: TAKT_CONFIG_DIR が空文字なら、takt と同じく ~/.takt を読む', async (t) => {
  const box = makeSandbox();
  const s = await start(t, box, { TAKT_CONFIG_DIR: '' });
  const body = await getState(s, box.run);
  assert.deepEqual(subs(body)['custom-tagged-review'], { provider: 'opencode', model: 'home' });
  assert.ok(body.runs.some((r) => r.runDir === box.homeUi));
});

test('CFGDIR-RELATIVE: TAKT_CONFIG_DIR が相対パスなら、起動時のカレントディレクトリから解決する', async (t) => {
  const box = makeSandbox();
  const s = await start(t, box, { TAKT_CONFIG_DIR: path.join('..', 'custom-takt') });
  const body = await getState(s, box.run);
  assert.deepEqual(subs(body)['home-tagged-review'], { provider: 'codex', model: 'custom' });
  // 一覧の runDir は絶対パス。takt ui の run の判定（絶対パスで照合）も通る
  assert.match(body.runs.find((r) => r.runDir === box.customUi)?.label ?? '', /^UI: /);
});

test('CFGDIR-BACKUP: run 開始時点の設定のバックアップも TAKT_CONFIG_DIR から選ぶ', async (t) => {
  const box = makeSandbox();
  // バックアップの mtime は「その内容が置き換えられた時刻」。run 開始の 1 時間後に置き換えた = run 開始時点ではこの内容だった
  const replacedAt = new Date(Date.parse(START) + HOUR * 1000);
  for (const [dir, provider] of [[box.custom, 'copilot'], [path.join(box.home, '.takt'), 'cursor']]) {
    const bak = path.join(dir, 'runtime.yaml.bak-20261101-test');
    fs.writeFileSync(bak, runtimeYaml(provider, 'old'));
    fs.utimesSync(bak, replacedAt, replacedAt);
  }
  const s = await start(t, box, { TAKT_CONFIG_DIR: box.custom });
  assert.deepEqual(subs(await getState(s, box.run))['home-tagged-review'], { provider: 'copilot', model: 'old' });
});
