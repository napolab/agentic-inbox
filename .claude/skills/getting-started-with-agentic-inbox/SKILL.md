---
name: getting-started-with-agentic-inbox
description: Use when someone is new to this repository or to Claude Code / Codex and asks how to set up, deploy or run this napolab fork of cloudflare/agentic-inbox, what it adds over upstream, or how to connect its MCP server; also when they hit "Cloudflare Access must be configured", "Missing required CF Access JWT", "Invalid or expired Access token", mail that never arrives, or a failing Deploy workflow.
---

# Getting Started with napolab/agentic-inbox

## Overview

`cloudflare/agentic-inbox`（Cloudflare Workers 上のセルフホスト型メールクライアント + AI エージェント）の napolab fork。本家の履歴の上に napolab の変更が積まれている。リポジトリの値は全部プレースホルダなので、**自分の値に置き換えるまでデプロイしても動かない**。

認証は Cloudflare Access 一本（Worker は Access の JWT が無いリクエストを全部拒否する）。MCP も Access の後ろに置き、**クライアントからは MCP server portal 経由で使う**のが推奨構成。

## Claude Code / Codex で触るとき

| 何 | 場所 |
| --- | --- |
| コーディング規約 | `.claude/rules/*.md`（Claude Code は自動で読む。Codex では作業前に読ませる） |
| skills | Claude Code: `.claude/skills/`（全部）/ Codex: `.agents/skills/`（この skill のコピーのみ）。Codex に置く skill は `.claude` 側を編集してからコピーし、`pnpm test` の同期テストで一致を確認 |
| MCP の変更を検証 | `.claude/skills/testing-mcp-tools-over-protocol/SKILL.md`（Codex では直接読ませる） |

検証コマンド（コード変更後に必ず実行）:

```bash
cp .dev.vars.example .dev.vars   # 初回のみ。無いと typecheck が Env 型の不足で落ちる
pnpm typecheck
pnpm test                        # durableObject のテストは sqlite3 CLI が必要
```

## デプロイ手順（上から順に）

0. **前提**: 受信・UI に使うドメインのゾーンが同じ Cloudflare アカウントにある / Node 22 + pnpm で `pnpm install` / `pnpm wrangler login`（ブラウザが開くので本人が実行）/ GitHub では**自分の fork** に push する（`napolab/agentic-inbox` に直接 push しない）
1. **プレースホルダを置換**（`main` への push 前に）
   - `wrangler.jsonc`: `routes[0].pattern`（UI のドメイン）、`DOMAINS`（受信ドメイン、カンマ区切り）、`TEAM_DOMAIN`、必要なら `name` と R2 の `bucket_name`
   - `workers/notifiers/format.ts` の `APP_ORIGIN` を route と同じ URL に（通知リンクの飛び先）
   - `workers_dev: false` なので**カスタムドメイン必須**
2. **R2 バケット作成**: `pnpm wrangler r2 bucket create <bucket_name>`
3. **初回デプロイ**: `pnpm run build && pnpm wrangler deploy` → この時点の HTTP 500「Cloudflare Access must be configured」は正常
4. **Cloudflare Access**: Worker の Settings > Domains & Routes でカスタムドメインに Access を有効化（出なければ Zero Trust で self-hosted アプリを作る）。AUD タグを `pnpm wrangler secret put POLICY_AUD`。**`TEAM_DOMAIN` は `wrangler.jsonc` の var のまま**（同名 secret は作らない）
5. **受信**: `DOMAINS` の**全ドメイン**で Email Routing の catch-all をこの Worker に向ける
6. **送信**: Email Service で送信ドメインを有効化し DNS レコードを追加（`send_email` バインディング）
7. **任意の secret**: `DISCORD_WEBHOOK_URL`、`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`（鍵生成コマンドは `.dev.vars.example`）。未設定なら該当通知はスキップ
8. **GitHub Actions**: repo secret に `CLOUDFLARE_API_TOKEN`（トークンが複数アカウントに効くなら `CLOUDFLARE_ACCOUNT_ID` も）。fork は Actions タブでワークフローを有効化。`upstream-sync` を使うなら Settings > Actions > General で「Allow GitHub Actions to create and approve pull requests」を ON

## upstream-sync（毎日 06:00 JST）

取り込み元はリポジトリ変数 `UPSTREAM_REPO`（Settings > Secrets and variables > Actions > Variables）で決まる。

| repo | `UPSTREAM_REPO` |
| --- | --- |
| napolab/agentic-inbox | `cloudflare/agentic-inbox`（設定済み） |
| その fork（あなたのデプロイ用 repo） | 未設定のまま = `napolab/agentic-inbox` から取り込む |

- **`.github/workflows/upstream-sync.yml` は編集しない**。全 repo で同一内容に保つ前提で、sync が workflow ファイルを変えないようにしている（Actions のトークンは workflow を変える push ができない）。取り込み元を変えたいときは変数だけ変える
- job は `main` に upstream を merge したブランチ `upstream-sync` を push して PR を作る。この PR は Actions のトークンで作られるので CI が走らない → 差分を確認してから**必ず merge commit でマージ**（squash / rebase だと同じコミットが毎回取り込み対象に戻る）
- job が止まったら手元でマージして PR を手で作る:
  ```bash
  git switch -c sync-upstream origin/main
  git fetch https://github.com/napolab/agentic-inbox.git main   # UPSTREAM_REPO の値
  git merge --no-ff FETCH_HEAD    # 衝突を解消して commit → push → PR → merge commit でマージ
  ```

## MCP をつなぐ（推奨: Access + MCP Portal）

Worker の `/mcp`（Streamable HTTP）は Access の後ろにある。クライアントに Access の service token を直接持たせるより、**Cloudflare One の MCP server portal に登録してポータル経由で使う**。ログインは Access の OAuth で済み、ツール単位の可視性やログもポータル側で管理できる。

1. Worker の Access アプリ（手順 4 で作ったもの）で **Managed OAuth を有効化**する。Worker は Access が付ける自分の AUD の JWT を検証するので、そのまま使える
2. Zero Trust > Access controls > MCP Portals > MCP servers > Add MCP server で `https://<UI のドメイン>/mcp` を登録し、表示される OAuth ログインを済ませる
3. Add server portal でポータルを作成（カスタムドメイン + Access ポリシー）し、2 のサーバーを追加
4. クライアント登録（ポータルの URL は `https://<portal のドメイン>/mcp`）:
   - Claude Code: `claude mcp add --transport http inbox https://<portal>/mcp` → `/mcp` でログイン
   - Codex: `codex mcp add inbox --url https://<portal>/mcp` → `codex mcp login inbox`

ローカル開発（`pnpm dev`）では Access がスキップされ、`http://localhost:5173/mcp` に直接つながる。

docs: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/ , https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

## 本家から増えた機能

| 機能 | 追加設定 |
| --- | --- |
| 新着メールの Discord 通知（Workers AI による日本語要約 + 重要度の色分け） | `DISCORD_WEBHOOK_URL` |
| Web Push 通知 + PWA（ヘッダーのボタンで ON） | VAPID の 3 つの secret |
| 複数ドメイン + catch-all（初受信で mailbox を自動作成、SMTP の envelope 宛先を優先） | `DOMAINS`、各ドメインの catch-all |
| auto-draft はメールボックスごとのオプトイン（既定 OFF） | Settings 画面の「Auto-draft replies」 |
| 作成画面と MCP `send_email` / `send_reply` の添付ファイル | なし |
| MCP `list_all_inbox_emails`（全受信箱を横断して一覧・検索）、失敗は型付きエラーで返す | なし |
| ライト / ダーク / システムのテーマ切替 | なし |
| 本文の HTML / テキスト保存、返信スレッドの Message-ID、送信レート制限の窓などの修正 | なし（DB は自動マイグレーション） |
| CI（PR で typecheck + test）、main への push で deploy、毎日の upstream 同期 PR | GitHub Actions の設定（手順 8） |
| Gmail Takeout mbox の取り込みスクリプト `pnpm import:mbox` | サーバー側の import API が削除済みのため `--dry-run` のみ |

Access を通ったユーザーは**全メールボックス**を操作できる（MCP も `mailboxId` 指定で同じ）。Access ポリシーは自分だけに絞る。

## よくあるつまずき

| 症状 | 原因 → 対処 |
| --- | --- |
| HTTP 500「Cloudflare Access must be configured」 | `POLICY_AUD` 未登録 → 手順 4 |
| 403「Missing required CF Access JWT」 | Access を通っていない経路で呼んでいる（MCP クライアントの直接接続など）→ Access を有効化 / ポータル経由にする |
| 403「Invalid or expired Access token」 | `POLICY_AUD` か `TEAM_DOMAIN` が別アプリの値 → Access の画面の値で登録し直す |
| 一部ドメインのメールが届かない | そのドメインの catch-all が Worker を向いていない |
| 通知のリンクが `inbox.example.com` に飛ぶ | `APP_ORIGIN` を置換し忘れ |
| Deploy workflow が「CLOUDFLARE_API_TOKEN」で失敗 | repo secret 未登録（手順 8） |
| typecheck で `DISCORD_WEBHOOK_URL does not exist in type` | `.dev.vars` が無い → `cp .dev.vars.example .dev.vars` |
| `pnpm deploy` が Worker をデプロイせず pnpm のエラーになる | `pnpm deploy` は pnpm 組み込みコマンド → `pnpm run deploy` か `pnpm run build && pnpm wrangler deploy` |
| Upstream Sync が「conflicts」で止まる | upstream と main が衝突 → upstream-sync 節の手元マージ |
| Upstream Sync が「changes .github/workflows」で止まる | upstream が workflow を変えた（トークンでは push 不可）→ 同じく手元マージ（自分の権限なら push できる）。自分で `deploy.yml` などを編集しただけでは起きない |
| Upstream Sync の push が `refusing to allow a GitHub App to create or update workflow` | 手元の `upstream-sync.yml` が古いか編集されている → upstream の同じファイルの内容に戻す |
| 同じ upstream コミットが毎回 sync PR に出る | sync PR を squash / rebase でマージした → 手元マージで取り込み、以後 merge commit で |
| durableObject のテストが `spawnSync sqlite3 ENOENT` | sqlite3 CLI を入れる（CI の ubuntu には入っている） |
| MCP クライアントの設定に service token を書いて repo に入れた | project スコープの `.mcp.json` は git に入る → token を失効させ、ポータル経由に切り替える |
