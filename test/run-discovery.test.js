// 実行: node --test test/run-discovery.test.js
// run の探索（findRuns）と tasks.yaml の逆引き（tasksYamlFor）が、ユーザーの環境の違いで run を落とさないこと:
//   - roots の直下に stat できない項目（リンク先の無いリンク）があっても、同じディレクトリの run を出す
//   - roots の区切りは , だけ（--roots と config.yaml で同じ）。: を含むパス（Windows のドライブ指定など）を分けない
//   - tasks.yaml の worktree_path に空白を含むパスがあっても、その worktree の run を出し、タスクを対応づける
// bin/takt-dashboard を子プロセスで起動し、/api/state で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

// tasks.yaml の worktree_path と root を文字列で比べるので、実パスにそろえる
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const EMPTY = path.join(ROOT, 'empty'); // run も tasks.yaml も無い cwd

// stat できない項目: リンク先の無いリンクと、正常なリポジトリを同じ roots の直下に並べる
const BROKEN_ROOTS = path.join(ROOT, 'broken-roots');
const BR_REPO = path.join(BROKEN_ROOTS, 'repo');
const BR_RUN = path.join(BR_REPO, '.takt', 'runs', '20261029-100000-br');
// BR_REPO の clone-meta と tasks.yaml から辿る worktree（roots の外）
const BR_WT = path.join(ROOT, 'br-wt');
const BR_WT_RUN = path.join(BR_WT, '.takt', 'runs', '20261029-110000-brwt');

// roots の区切り: a と、: を含む x:y の 2 つ
const SPLIT = path.join(ROOT, 'split');
const SPLIT_A = path.join(SPLIT, 'a');
const SPLIT_COLON = path.join(SPLIT, 'x:y');
const A_RUN = path.join(SPLIT_A, 'repo-a', '.takt', 'runs', '20261029-120000-a');
const COLON_RUN = path.join(SPLIT_COLON, 'repo-c', '.takt', 'runs', '20261029-130000-c');
const HOME_CFG = path.join(ROOT, 'home-cfg'); // config.yaml に roots を書く HOME

// 空白を含む worktree_path: cwd（REPO）の tasks.yaml にだけ書き、clone-meta は置かない
const REPO = path.join(ROOT, 'repo');
const WT_SPACE = path.join(ROOT, 'my wt');
const SPACE_RUN = path.join(WT_SPACE, '.takt', 'runs', '20261029-140000-space');
const WT_PLAIN = path.join(ROOT, 'wt-plain');
const PLAIN_RUN = path.join(WT_PLAIN, '.takt', 'runs', '20261029-150000-plain');

// 別の worktree のタスクを付けないこと: tasks.yaml の worktree_path は「my wt2」だけで、run は「my wt」にある
const OTHER = path.join(ROOT, 'other');
const OTHER_REPO = path.join(OTHER, 'repo');
const OTHER_WT = path.join(OTHER, 'my wt');
const OTHER_RUN = path.join(OTHER_WT, '.takt', 'runs', '20261029-160000-other');

function writeRun(runDir, slug, updatedAt) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）。completed なので中断判定は走らない
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'plan', startTime: updatedAt, updatedAt }));
}
// takt は tasks.yaml を yaml ライブラリの stringify で書く。空白を含むパスも引用符なしの平文になる（takt 0.74.0 の yaml で確認）
// 各タスクの最初のキーは「  - 」の行に書かれる。parseTasks は 4 スペース字下げの行だけを読むので、確かめる name は 2 つ目以降に置く
function writeTasks(repo, tasks) {
  fs.mkdirSync(path.join(repo, '.takt'), { recursive: true });
  const lines = ['tasks:', ...tasks.flatMap((t) => Object.entries(t).map(([k, v], i) => (i === 0 ? '  - ' : '    ') + k + ': ' + v))];
  fs.writeFileSync(path.join(repo, '.takt', 'tasks.yaml'), lines.join('\n') + '\n');
}

const getState = async (server, query = '') => (await fetch(server.base + '/api/state' + query)).json();
const runParam = (runDir) => '?run=' + encodeURIComponent(runDir);
const runDirs = (body) => body.runs.map((r) => r.runDir);

const servers = [];
const start = async (opts) => { const s = await startDashboard(opts); servers.push(s); return s; };
let broken, splitByArg, splitByConfig, spaced, other;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(EMPTY, { recursive: true });

  writeRun(BR_RUN, '20261029-100000-br', '2026-10-29T10:00:00.000Z');
  // リンク先の無いリンク（takt list で消した worktree へのリンクなど）。Windows でも管理者権限なしで作れる junction を指定する（他の OS では無視される）
  fs.symlinkSync(path.join(ROOT, 'removed-worktree'), path.join(BROKEN_ROOTS, 'a-broken'), 'junction');
  writeRun(BR_WT_RUN, '20261029-110000-brwt', '2026-10-29T11:00:00.000Z');
  fs.mkdirSync(path.join(BR_REPO, '.takt', 'clone-meta'), { recursive: true });
  fs.writeFileSync(path.join(BR_REPO, '.takt', 'clone-meta', 'x.json'), JSON.stringify({ clonePath: BR_WT }));
  writeTasks(BR_REPO, [{ status: 'completed', name: 'br-task', worktree_path: BR_WT }]);

  writeRun(A_RUN, '20261029-120000-a', '2026-10-29T12:00:00.000Z');
  writeRun(COLON_RUN, '20261029-130000-c', '2026-10-29T13:00:00.000Z');
  fs.mkdirSync(path.join(HOME_CFG, '.config', 'takt-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(HOME_CFG, '.config', 'takt-dashboard', 'config.yaml'), 'roots: ' + SPLIT_A + ', ' + SPLIT_COLON + '\n');

  writeRun(SPACE_RUN, '20261029-140000-space', '2026-10-29T14:00:00.000Z');
  writeRun(PLAIN_RUN, '20261029-150000-plain', '2026-10-29T15:00:00.000Z');
  writeTasks(REPO, [
    { status: 'completed', name: 'space-task', worktree_path: WT_SPACE },
    { status: 'completed', name: 'plain-task', worktree_path: WT_PLAIN },
  ]);

  writeRun(OTHER_RUN, '20261029-160000-other', '2026-10-29T16:00:00.000Z');
  writeTasks(OTHER_REPO, [{ status: 'completed', name: 'other-task', worktree_path: path.join(OTHER, 'my wt2') }]);

  broken = await start({ cwd: EMPTY, home: HOME, args: ['--roots', BROKEN_ROOTS] });
  splitByArg = await start({ cwd: EMPTY, home: HOME, args: ['--roots', SPLIT_A + ',' + SPLIT_COLON] });
  splitByConfig = await start({ cwd: EMPTY, home: HOME_CFG });
  spaced = await start({ cwd: REPO, home: HOME });
  other = await start({ cwd: OTHER_REPO, home: HOME, args: ['--roots', OTHER] });
});

after(async () => {
  for (const s of servers) await stopDashboard(s);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('roots の直下にリンク先の無いリンクがあっても、同じディレクトリのリポジトリの run を一覧に出す', async () => {
  const body = await getState(broken);
  assert.ok(runDirs(body).includes(BR_RUN), JSON.stringify(runDirs(body)));
});

test('roots の直下にリンク先の無いリンクがあっても、リポジトリから辿る worktree の run を一覧に出し、repo と currentTask を対応づける', async () => {
  assert.ok(runDirs(await getState(broken)).includes(BR_WT_RUN), '一覧に出る');
  const body = await getState(broken, runParam(BR_WT_RUN));
  assert.equal(body.active.runDir, BR_WT_RUN);
  assert.equal(body.repo, 'repo', 'tasks.yaml の置き場のリポジトリ名');
  assert.equal(body.currentTask?.name, 'br-task');
});

test('--roots はカンマで区切り、: を含むパスは分けない', async () => {
  const dirs = runDirs(await getState(splitByArg));
  assert.ok(dirs.includes(A_RUN), JSON.stringify(dirs));
  assert.ok(dirs.includes(COLON_RUN), JSON.stringify(dirs));
});

test('config.yaml の roots: a, b も --roots と同じ規則で区切る', async () => {
  const dirs = runDirs(await getState(splitByConfig));
  assert.ok(dirs.includes(A_RUN), JSON.stringify(dirs));
  assert.ok(dirs.includes(COLON_RUN), JSON.stringify(dirs));
});

test('tasks.yaml の worktree_path に空白を含むパスがあっても、--roots なし・clone-meta なしでその worktree の run を一覧に出し、タスクを対応づける', async () => {
  assert.ok(runDirs(await getState(spaced)).includes(SPACE_RUN), '一覧に出る');
  const body = await getState(spaced, runParam(SPACE_RUN));
  assert.equal(body.active.runDir, SPACE_RUN);
  assert.equal(body.currentTask?.name, 'space-task');
  assert.equal(body.repo, 'repo');
});

test('空白を含まない worktree_path も、今までどおり一覧に出てタスクを対応づける', async () => {
  assert.ok(runDirs(await getState(spaced)).includes(PLAIN_RUN), '一覧に出る');
  const body = await getState(spaced, runParam(PLAIN_RUN));
  assert.equal(body.currentTask?.name, 'plain-task');
});

test('tasks.yaml に無い worktree の run には、名前の似た別の worktree のタスクを付けない', async () => {
  const body = await getState(other, runParam(OTHER_RUN));
  assert.equal(body.active.runDir, OTHER_RUN);
  assert.equal(body.currentTask, null);
});
