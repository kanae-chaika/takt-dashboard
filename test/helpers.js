// テスト共通: bin/takt-dashboard を子プロセスで起動・停止する。
// --port 0 で起動し、OS が選んだポートを起動メッセージから読む（空きポートを先に調べてから渡すと、その間に別のプロセスに取られることがある）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/takt-dashboard', import.meta.url));
const STARTUP_TIMEOUT_MS = 10000;

// home は HOME にする一時ディレクトリ（実際の ~/.takt や ~/.config/takt-dashboard を読ませない）。env は追加・上書きする環境変数
export function spawnDashboard({ cwd, home, args = [], env = {} }) {
  const e = { ...process.env, HOME: home };
  delete e.TAKT_DASHBOARD_ROOTS;
  delete e.TAKT_DASHBOARD_PORT;
  Object.assign(e, env);
  const proc = spawn(process.execPath, [BIN, '--port', '0', ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '' };
  proc.stdout.on('data', (d) => { out.stdout += d; });
  proc.stderr.on('data', (d) => { out.stderr += d; });
  // 'exit' の時点では stdout / stderr が読み終わっていないことがあるので、閉じた後の 'close' を待つ
  const exited = new Promise((resolve) => proc.once('close', (code, signal) => resolve({ code, signal })));
  return { proc, out, exited };
}

// 起動メッセージが出るまで待ち、実際のポートと URL を足して返す。起動できなければ子プロセスを止めてから投げる（残るとテストが終わらない）
export async function startDashboard(opts) {
  const d = spawnDashboard(opts);
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('起動待ちがタイムアウト: ' + JSON.stringify(d.out))), STARTUP_TIMEOUT_MS);
      // 起動メッセージが複数の data に分かれても見落とさないよう、連結した出力を行末（\n）まで受け取ってから読む
      d.proc.stdout.on('data', () => { const m = d.out.stdout.match(/takt-dashboard: http:\/\/localhost:(\d+)\n/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      d.exited.then((r) => { clearTimeout(timer); reject(new Error('起動前に終了: ' + JSON.stringify({ ...r, ...d.out }))); });
    });
    return { ...d, port, base: 'http://127.0.0.1:' + port };
  } catch (e) {
    await stopDashboard(d);
    throw e;
  }
}

// 終了済みのプロセスでも exited は解決済みなので、待ち続けない
export async function stopDashboard(d) {
  if (!d) return;
  if (d.proc.exitCode === null && d.proc.signalCode === null) d.proc.kill('SIGTERM');
  await d.exited;
}
