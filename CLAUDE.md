# takt-dashboard

[TAKT](https://github.com/nrslib/takt) の run をブラウザで見張るローカル Web ダッシュボード。
ユーザー向けの説明・使い方は README.md を正とする。ここには開発時に守ることだけ書く。

## 構成

| パス | 内容 |
|---|---|
| `bin/takt-dashboard` | サーバー（Node.js）。拡張子なし・ESM。`/` では `bin/ui/index.html` の `<link>` と `<script src>` を `app.css` / `app.js` の中身に置き換えて 1 枚の HTML にして返す（`pageHtml()`。配信のルートは `/` だけ） |
| `bin/ui/` | ブラウザ側。`index.html`（骨組み）・`app.css`・`app.js`。リクエストごとに読むので、`npm link` 中はブラウザのリロードで編集が反映される |
| `test/*.test.js` | `node:test` のテスト。`bin/takt-dashboard` を子プロセスで起動し、HTTP 応答と終了コードで確認する |
| `docs/` | README 用のスクリーンショットのみ |
| `.coderabbit.yaml` | CodeRabbit の設定（日本語・assertive・draft PR もレビュー） |
| `eslint.config.js` | ESLint の設定（検査のみ。サーバー・テストは Node.js の ESM、`bin/ui/app.js` はブラウザのグローバルな script として読む） |
| `.github/workflows/ci.yml` | CI。push / PR ごとに `npm run lint` と `npm test` を ubuntu / windows / macos × Node 20 / 22 で回す |
| `.github/workflows/dismiss-stale-coderabbit-approval.yml` | PR に push されたら、CodeRabbit が古いコミットに出した Approved を取り消す（最新のコミットへの Approved は残す） |

`bin/takt-dashboard` と `bin/ui/app.js` の中は `// ---------- 見出し ----------` でセクション分けされている（サーバー: 設定 / run 探索 / 中断判定 / routing / タイムライン / レポート / tasks.yaml / state / HTML / サーバー）。コードを足すときは該当セクションに入れる。

## 前提

**このダッシュボードは公開して配布するソフトウェアであり、実装者の環境専用ではない。** 設計・実装・テストのすべてで、実装者とは異なる環境のユーザーを前提に考える。

- ユーザーの環境は実装者と違う。takt のバージョン・設定（`~/.takt/runtime.yaml` / `config.yaml` の有無や内容）・ディレクトリ構成・OS・リポジトリの置き方・run の数や状態（失敗・中断・ログ欠損）は、実装者の手元と同じとは限らない
- 実装者の手元で動いたことを「正しい」の根拠にしない。想定どおりの入力だけでなく、設定ファイルが無い・形式が少し違う・run が壊れている場合も落ちずに動くことを確認する
- 実装者の手元のパス・リポジトリ名・設定値をコードや既定値に埋め込まない。環境依存の値はコマンドライン / 環境変数 / 設定ファイルから受け取る
- README は初見のユーザーが読む前提で書く。実装者だけが知っている前提や経緯を省略しない

## takt の用語（ログの読み方）

- **run**: takt の 1 回の実行。`<root>/.takt/runs/<slug>/` に `meta.json`（status・currentStep・startTime など）・`logs/*.jsonl`（イベント）・`reports/*.md` が入る。`takt ui` から起動した run は `~/.takt/state/projects/<id>/runs/` にある
- **step / iteration**: ワークフローのステップ（plan・implement など）と、その何周目か。タイムラインのキーは `step#iteration`
- **phase**: step の中の execute → report → judge。judge の結果は `phase_complete`（phaseName が judge）の `content` に一致した rule のラベル（`approved` / `needs_fix` など）、理由は `phase_judge_stage` の `response`（structured output の JSON）に入る
- **並列の子（sub）**: 並列ステップの子。イベントに provider / model が無いので、usage_events のログがあればそこから、無ければ run 開始時点の routing から引く（`ladder` / `pool` / `assignments` / `personas` のように設定から決まらないものは null）
- 読んでいるイベント種別: `step_start` / `step_complete` / `phase_start` / `phase_complete` / `phase_judge_stage`
- `logs/` には `type` の無い jsonl（`*-usage-events.jsonl` など）も書かれる。イベントとして読むのは `type` が文字列の記録だけ。`*-usage-events.jsonl`（takt の `logging.usage_events` が有効なときだけ書かれる）は、並列の子の実際の provider / model として別に読む
- 対応している形式は takt **0.74.0** で確認したもの（実際の run のログで確認。provider の切替の通知文と `runtime.yaml` の `provider:` 配下の書き方は、takt 0.74.0 の mock provider で作った run で確認）。takt 側の形式は実験的機能で予告なく変わる。形式に依存する箇所を直したときは README の「注意」のバージョンも見直す

## 設計方針（変えない）

- **依存ライブラリなし。** Node.js 標準ライブラリだけで動かす（`package.json` に dependencies を足さない）。yaml（`config.yaml` / `runtime.yaml` / `tasks.yaml`）も自前の簡易パースで読む
- **ビルドしない。** ブラウザ側は `bin/ui/` の素の HTML / CSS / JS をサーバーが読んで返すだけで、バンドラや変換は入れない
- **読むだけ。** takt 本体の `~/.takt/` には書き込まない。ダッシュボード自身のデータは `~/.config/takt-dashboard/` に置く
- **ローカル専用。** `127.0.0.1` にだけ bind する。認証はない
- **run 開始時点の設定を使う。** 並列の子の provider / model は run ごとに `routing/<run slug>.json` に保存し、以後 yaml を変えても過去の表示を変えない
- **`?run=` で指定した run が無いときに別の run へフォールバックしない。** `runNotFound` を返し、URL と表示を食い違わせない
- ハンドラ内の例外でプロセスを落とさない（500 を返す）

## 画面（`bin/ui/`）の前提

- **2 秒ごとに `/api/state` を取り、応答が前回と違えば画面全体を描き直す**（`tick()`）。UI を足すときは、2 秒後の再描画で消えないか・守る仕組みが要るかを考える。選択中の run は `selGen`（選択の世代番号）で古い応答を捨て、スクロール位置は `restoreScroll` で戻している
- `app.js` は `index.html` の `onclick` から呼ぶ関数があるので、モジュールではなくグローバルな script として読まれる（ESLint の設定もそれに合わせている）
- `app.css` も「既存のスタイルを勝手に変えない」の対象。見た目が変わる変更は、手を動かす前にユーザーに確認する
- `?demo=1` を付けると `demoize()` がリポジトリ名・タスク名・ブランチをサンプル値に置き換える。README のスクリーンショットを撮るときはこれを使い、実名を写さない

## 開発

```bash
npm link                     # takt-dashboard コマンドが clone 先を指す
npm install                  # テストと ESLint 用（実行時の依存は無い）
npm test                     # node --test（引数なし。test/ 配下を既定の探索で実行。glob を書かないのは Windows の npm スクリプトも Node 20 の test runner も展開しないため）
npm run lint                 # ESLint（検査のみ）
```

- `engines.node >= 20` は実行時の要件。開発ツールの ESLint 10 は Node.js 20.19 以上 / 22.13 以上 / 24 以上が必要（21・23 は対象外）なので、手元の Node が古いと `npm install` が失敗することがある
- `node:test` を使うので別のテストランナーは入れない
- **push 前にローカルで `npm run lint` と `npm test` を通す。** CI（GitHub Actions）でも同じものが回るが、CI 待ちで直すのではなく手元で通してから push する
- ESLint は検査だけで、formatter は無い。シングルクォート・セミコロンあり・1 行に詰める既存の書き方に揃える。ESLint の指摘を黙らせるルール追加は、既存の書き方を守るために必要な場合だけにする（既存の `allowEmptyCatch` / `no-regex-spaces` / `ignoreRestSiblings` がその例）
- テストは実環境の `~/.takt` / `~/.config/takt-dashboard` を読まないよう、`HOME`（Windows では `os.homedir()` が見る `USERPROFILE` も）と cwd を一時ディレクトリにして起動する（起動・停止は `test/helpers.js` の `startDashboard` / `stopDashboard` を使う。`--port 0` で起動し、起動メッセージから実際のポートを読む）
- テストで run を作るときは `<root>/.takt/runs/<slug>/` に `meta.json` を置く（必須はこれだけ）。`logs/*.jsonl`・`reports/*.md` はそのテストで使う場合だけ作る
- 手元に無い状況（失敗・レート上限による provider の切替・設定の書き方の違い）の本物のログは、takt の mock provider で作れる。LLM を呼ばず、ログは takt のエンジンが書く
  - 一時ディレクトリを `HOME` にして、`~/.takt/runtime.yaml` の profile の provider を `mock` にする（実環境の `~/.takt` を書き換えない）
  - 一時の git リポジトリで `takt -w <workflow> -t <タスク> --pipeline --skip-git -q` を実行する。並列の子の確認には組み込みの `compound-eye`（子 `eye1` / `eye2`）が使える
  - 応答は環境変数 `TAKT_MOCK_SCENARIO` の JSON（`[{ persona, status, content, structured_output }]` の配列）で決める。judge は persona `conductor` で呼ばれる（`compound-eye` で確認）ので、`structured_output: { "step": 1, "reason": "…" }` で rule 1 に一致させる（無いと `rule_no_match` で失敗する）
  - provider の切替は、`config.yaml` に `rate_limit_fallback.switch_chain` を書き、シナリオで `status: "rate_limited"` を返すと起きる

## コードの書き方

- コメント・テスト名・コミットメッセージ・UI 文言は日本語
- コメントには「何をするか」ではなく「なぜそうするか」（takt のどの挙動に合わせたか等）を書く。既存の書き方に揃える
- boolean は `is` / `has` 始まりの肯定形（例: `isRunMissing`）

## README

- 日本語と英語（`## English` 以下）の 2 部構成。挙動・オプション・設定ファイルを変えたら**両方**を更新する
- 画面の文言を README や Issue / PR に書くときは、`bin/takt-dashboard` の実際の文言を確認してから書く

## コミット・PR

- コミットメッセージは `fix:` / `feat:` / `docs:` / `chore:` + 日本語の説明。1 行目だけで「何を・なぜ」が分かるようにする（例: `fix: 127.0.0.1 にだけ bind する（README の「ローカル専用」の記述どおりに）`）
- `main` への直接 push はしない。PR を経由する
- PR は CodeRabbit（assertive）がレビューする。指摘には対応するか、対応しない理由を返す
