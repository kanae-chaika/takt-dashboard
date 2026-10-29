# takt-dashboard

[TAKT](https://github.com/nrslib/takt) の run をブラウザで見張るローカルダッシュボードです。
依存ライブラリなし（Node.js 標準ライブラリのみ）、1 ファイルで動きます。

[English](#english) is below.

## できること

- **タイムライン**: ステップの開始・完了を時刻順に。並列ステップは子ごとに木にして、execute / report / judge の終了時刻を並べる
- **判定結果**: 各ステップ・子の judge 結果（`approved` / `needs_fix` / 一致した rule 名）を行に表示。クリックで judge の理由（structured output の reason）を開く
- **実行経路**: 公式 Web UI の実行経路に似たカード + ポート + 曲線の図。並列は枠の中に子を縦に並べ、リトライは枠が 2 つ並ぶ
- **レート上限・リトライ**: `rate_limited` で中断 → リトライした経緯と、provider の切替（`codex/gpt-5 → claude/sonnet`）を開始行に表示
- **中断・失敗**: プロセスが落ちて `running` のまま残った run を「中断」と判定し、どのステップで止まったかを終了行に出す。失敗は理由（`rule_no_match` など）と judge のエラーログ付き
- **provider / model**: 並列の子はログに provider が無いので、run 開始時点の `~/.takt/runtime.yaml`（または `config.yaml`）から引く。run ごとに結果を保存するので、後から yaml を変えても過去の表示は変わらない
- **レポート**: run の `reports/*.md` をステップに紐づけて一覧。クリックで本文を表示
- 複数リポジトリ・worktree の run をまとめて一覧。2 秒ごとに自動更新

## 使い方

```bash
npm install -g github:kanae-chaika/takt-dashboard   # takt-dashboard コマンドが入る（依存パッケージなし）

cd /path/to/your-repo    # takt を使っているリポジトリで
takt-dashboard           # → http://localhost:7331
```

リポジトリで起動すると、そのリポジトリの `.takt/clone-meta/` と `.takt/tasks.yaml` から takt が作った worktree を辿って、run をまとめて一覧にします。`~/.takt`（`takt ui` から起動した run）も見ます。

| オプション | 説明 |
|---|---|
| `--roots ~/dev,~/projects` | 複数のリポジトリをまとめて見たいとき。リポジトリをまとめて置いているディレクトリを指定すると、その直下のリポジトリと worktree の `.takt/runs` を見る。カンマ区切りで複数指定できる。環境変数 `TAKT_DASHBOARD_ROOTS` でも指定できる |
| `--port N` | ポート（既定 7331）。環境変数 `TAKT_DASHBOARD_PORT` でも指定できる |
| `<run_dir>` | 表示する run ディレクトリを固定 |

毎回オプションを付けたくなければ、設定ファイルに書けます（コマンドライン > 環境変数 > 設定ファイル > 既定の順で優先）。

```yaml
# ~/.config/takt-dashboard/config.yaml
roots:
  - ~/dev
port: 7331
```

## ダッシュボードが使うディレクトリ

`~/.config/takt-dashboard/` に自分のデータを置きます。takt 本体の `~/.takt/` には書き込みません。

| ファイル | 内容 |
|---|---|
| `config.yaml` | 上の設定（任意） |
| `routing/<run slug>.json` | run ごとの provider 割り当ての控え（自動生成） |
| `takt-logo.svg` | ヘッダーのロゴを差し替えたいときだけ（任意）。通常は takt 本体に同梱のロゴ（`docs/assets/takt-logo-dark.svg`）を自動で使う |

## 過去の run の provider / model を正しく出すために

並列の子ステップは takt のログに provider / model が記録されません。そのため設定ファイルから引きますが、設定を後から変えると過去の run の表示が変わってしまいます。

これを避けるため、`~/.takt/runtime.yaml` や `config.yaml` を変更するときは、変更前のファイルを次の名前で残しておくと、ダッシュボードが「run 開始時点で有効だった設定」を自動で選びます。

```
~/.takt/runtime.yaml.bak-20261025-copilot-quota   # 変更前の内容。ファイルの更新時刻 = 置き換えた時刻
~/.takt/config.yaml.bak.20261020-runtime-v1
```

- `runtime.yaml.bak` / `config.yaml.bak` で始まる名前なら、後ろは自由
- 選んだ結果は `~/.config/takt-dashboard/routing/<run slug>.json` に保存され、以後は固定
- バックアップが無い場合は現在の設定値を使います（hover で「設定からの推定」と表示）

## 注意

- TAKT の Web UI と run のログ形式は「実験的機能」で、予告なく変わります。takt **0.73.0** のログで動作確認しています。追従は約束しません
- run のデータは worktree 側の `.takt/runs/` にあります。`takt list` でタスクを削除すると、その run はダッシュボードからも消えます
- ローカル専用です（`localhost` にしか bind しません）。認証はありません

## 開発する場合（通常は不要）

ダッシュボードのコード自体を改造したい場合だけ、`npm install -g` の代わりに clone して `npm link` します。`takt-dashboard` コマンドが clone 先を指すようになり、直した内容がそのまま反映されます。使うだけなら上の `npm install -g` で足ります。

```bash
git clone https://github.com/kanae-chaika/takt-dashboard.git
cd takt-dashboard && npm link
```

## ライセンス

MIT

---

## English

A local web dashboard for watching [TAKT](https://github.com/nrslib/takt) runs. Single file, no dependencies (Node.js standard library only).

**Features**

- Timeline of step starts/ends; parallel steps are grouped per child with execute / report / judge end times
- Judge results per step (`approved`, `needs_fix`, matched rule name) inline; click to see the judge's reason
- Execution path view (cards, ports and curves) similar to the official Web UI, including parallel fan-out and retries
- Rate-limit interruptions, retries and provider switches shown on the step's start row
- Detects runs whose process died while `running` and marks them "interrupted" with the step that was in flight; failed runs show the reason and the judge error log
- Resolves provider/model for parallel children from `~/.takt/runtime.yaml` (or `config.yaml`) **as of the run's start time**, using dated backups (`runtime.yaml.bak-*`, `config.yaml.bak.*`) when present; the result is saved per run under `~/.takt/dashboard/routing/`
- Lists runs across multiple repositories and worktrees; refreshes every 2 seconds

**Usage**

```bash
npm install -g github:kanae-chaika/takt-dashboard   # installs the takt-dashboard command (no dependencies)

cd /path/to/your-repo    # a repository where you use takt
takt-dashboard           # → http://localhost:7331
```

Started inside a repository, it follows the worktrees takt created (from `.takt/clone-meta/` and `.takt/tasks.yaml`) and lists all their runs, plus runs under `~/.takt` (started from `takt ui`).

| Option | Description |
|---|---|
| `--roots ~/dev,~/projects` | To watch several repositories at once: give the directory that holds your repositories; its immediate subdirectories (repositories and worktrees) are checked for `.takt/runs`. Several directories can be given, comma-separated. Also `TAKT_DASHBOARD_ROOTS` |
| `--port N` | Port (default 7331). Also `TAKT_DASHBOARD_PORT` |
| `<run_dir>` | Pin a specific run directory |

Defaults can be set in `~/.config/takt-dashboard/config.yaml` (`roots:` list and `port:`); command line > environment > config file > defaults. The dashboard keeps its own data there (`routing/` snapshots, optional `takt-logo.svg` override) and never writes into takt's `~/.takt/`. The header logo is read from the installed takt package (`docs/assets/takt-logo-dark.svg`).

**Caveats**: TAKT's run log format is experimental and may change; verified against takt 0.73.0. Run data lives in each worktree's `.takt/runs/`, so deleting a task in `takt list` removes it from the dashboard too. Binds to localhost only, no authentication.

**Development (not needed for normal use)**: only if you want to modify the dashboard itself, clone the repository and run `npm link` instead of `npm install -g`; the `takt-dashboard` command then points at your checkout.

License: MIT
