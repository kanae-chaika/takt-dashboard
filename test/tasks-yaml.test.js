// 実行: node --test test/tasks-yaml.test.js
// tasks.yaml の各タスクの先頭キー（「  - 」の行に書かれるキー）も、2 つ目以降のキーと同じように読めること。
// takt 0.74.0 は tasks.yaml を yaml ライブラリの stringify で書き、キーは zod の schema の順（goal_id・worktree・branch・issue などの実行設定 → name → status → …）に並ぶ。
// 先頭に来るのは、そのタスクにある最初のキー。実行設定が無いタスクは name、worktree を持たないタスクは branch や issue が先頭になる。
// bin/takt-dashboard を子プロセスで起動し、/api/state の currentTask で確認する。HOME と cwd は一時ディレクトリにして、実環境の ~/.takt や ~/.config/takt-dashboard を読ませない
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDashboard, stopDashboard } from './helpers.js';

// tasks.yaml の worktree_path と root を文字列で比べるので、実パスにそろえる
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'takt-dashboard-test-')));
const HOME = path.join(ROOT, 'home');
const REPO = path.join(ROOT, 'repo'); // cwd。.takt/tasks.yaml だけを置き、worktree の run は worktree_path から辿らせる

// 先頭に置くキーごとの worktree。どのタスクも同じキーと値を持ち、並びだけが違う
const FIRST_KEYS = ['name', 'branch', 'issue', 'summary', 'status', 'run_slug', 'worktree_path', 'created_at'];
const wtOf = (key) => path.join(ROOT, 'wt-' + key);
const slugOf = (key) => '20261103-100000-' + key.replace(/_/g, '-');
const runOf = (key) => path.join(wtOf(key), '.takt', 'runs', slugOf(key));
const taskOf = (key) => ({
  name: 'task-' + key, status: 'completed', branch: 'takt/1-' + key, issue: '1', run_slug: slugOf(key),
  summary: 'タスク ' + key, worktree_path: wtOf(key), created_at: '2026-11-03T10:00:00.000Z',
});
// 先頭キーを入れ替えた yaml の 1 タスク分（takt と同じく、先頭キーは「  - 」の行、残りは 4 スペース字下げ）
function taskYaml(firstKey) {
  const t = taskOf(firstKey);
  const entries = [[firstKey, t[firstKey]], ...Object.entries(t).filter(([k]) => k !== firstKey)];
  return entries.map(([k, v], i) => (i === 0 ? '  - ' : '    ') + k + ': ' + v).join('\n');
}

// takt 0.74.0 の TaskRunner（addTask → claimNextTasks → updateRunningTaskExecution → completeTask）が実際に書いた形。
// 値（パス・日時・slug）だけテスト用に置き換えている。worktree・branch・issue が name より前に来て、workflow は最後に移される
const WT_TAKT = path.join(ROOT, 'wt-takt');
const TAKT_SLUG = '20261103-110000-fix-bug';
const TAKT_RUN = path.join(WT_TAKT, '.takt', 'runs', TAKT_SLUG);
const TAKT_TASK = `  - worktree: true
    branch: takt/1-fix
    issue: 1
    name: fix-bug
    status: completed
    slug: fix-bug
    run_slug: ${TAKT_SLUG}
    execution_id: 7ee440fb-165b-4113-8c7c-57aba0bf6ff6
    summary: Fix the bug
    worktree_path: ${WT_TAKT}
    task_dir: .takt/tasks/fix-bug
    created_at: 2026-11-03T11:00:00.000Z
    started_at: 2026-11-03T11:00:01.000Z
    completed_at: 2026-11-03T11:10:00.000Z
    owner_pid: null
    owner_start_time: null
    workflow: default`;
// 先頭キー（summary）が複数行のブロックスカラーのタスク。yaml の stringify は先頭キーでも継続行を 6 スペース字下げで書く
const WT_MULTI = path.join(ROOT, 'wt-multi');
const MULTI_SLUG = '20261103-120000-multi';
const MULTI_RUN = path.join(WT_MULTI, '.takt', 'runs', MULTI_SLUG);
const MULTI_TASK = `  - summary: |-
      # 見出し
      本文
    name: multi
    status: completed
    run_slug: ${MULTI_SLUG}
    worktree_path: ${WT_MULTI}`;

function writeRun(runDir, slug) {
  fs.mkdirSync(runDir, { recursive: true });
  // workflow は入れない（maxStepsFor が PATH 上の takt を探しに行かないように）。completed なので中断判定は走らない
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'completed', runSlug: slug, currentStep: 'plan', startTime: '2026-11-03T10:00:00.000Z', updatedAt: '2026-11-03T10:00:00.000Z' }));
}

const getState = async (query = '') => (await fetch(server.base + '/api/state' + query)).json();
const runParam = (runDir) => '?run=' + encodeURIComponent(runDir);

let server;

before(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(REPO, '.takt'), { recursive: true });
  for (const key of FIRST_KEYS) writeRun(runOf(key), slugOf(key));
  writeRun(TAKT_RUN, TAKT_SLUG);
  writeRun(MULTI_RUN, MULTI_SLUG);
  const yaml = ['tasks:', ...FIRST_KEYS.map(taskYaml), TAKT_TASK, MULTI_TASK].join('\n') + '\n';
  fs.writeFileSync(path.join(REPO, '.takt', 'tasks.yaml'), yaml);
  server = await startDashboard({ cwd: REPO, home: HOME });
});

after(async () => {
  await stopDashboard(server);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('takt 0.74.0 が書いた tasks.yaml のタスクを読み、name・branch・issue・summary を返す', async () => {
  const body = await getState(runParam(TAKT_RUN));
  assert.equal(body.active.runDir, TAKT_RUN);
  const t = body.currentTask;
  assert.deepEqual(
    { name: t?.name, status: t?.status, branch: t?.branch, issue: t?.issue, run_slug: t?.run_slug, summary: t?.summary, worktree_path: t?.worktree_path, workflow: t?.workflow },
    { name: 'fix-bug', status: 'completed', branch: 'takt/1-fix', issue: '1', run_slug: TAKT_SLUG, summary: 'Fix the bug', worktree_path: WT_TAKT, workflow: 'default' },
  );
});

for (const key of FIRST_KEYS) {
  test(`先頭キーが ${key} のタスクも、2 つ目以降のキーと同じ値で読める`, async () => {
    // worktree_path が先頭でも、tasks.yaml から worktree を辿って run を一覧に出す
    const body = await getState();
    assert.ok(body.runs.some((r) => r.runDir === runOf(key)), runOf(key) + ' が一覧に無い');
    const t = (await getState(runParam(runOf(key)))).currentTask;
    const expected = taskOf(key);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, t?.[k]])), expected);
  });
}

test('先頭キーが複数行のブロックスカラーでも、継続行まで読む', async () => {
  const t = (await getState(runParam(MULTI_RUN))).currentTask;
  assert.equal(t?.name, 'multi');
  // summary は見出しの記号を外した 1 行目（parseTasks の summary の扱い。継続行は空白でつながる）
  assert.equal(t?.summary, '見出し 本文');
});
