# 自動テスト

アプリ本体は素のHTML/CSS/JSのままで、**npm依存は入れない**。
テストだけはヘッドレスChromeを動かすため、リポジトリの外に `puppeteer-core` を入れて実行する。

## 実行手順

```bash
# 1. アプリをローカル配信（プロジェクト直下で）
cd "G:/マイドライブ/2.副業/ai-news-app"
python -m http.server 8766 --bind 127.0.0.1

# 2. 別のシェルで、リポジトリ外の作業用フォルダに puppeteer-core を入れて実行
#    （Chrome本体は端末にインストール済みのものを使う。ブラウザのDLは不要）
mkdir -p ~/ai-news-test-work && cd ~/ai-news-test-work
npm install puppeteer-core

# ESM は「テストファイルの場所」を基準に node_modules を探すため、
# リポジトリ内の test_all.mjs を直接叩くと puppeteer-core を見つけられない。
# 作業用フォルダへコピーしてから実行する。
cp "G:/マイドライブ/2.副業/ai-news-app/tests/test_all.mjs" ./run_test.mjs
node ./run_test.mjs
```

Chromeのパスやアプリのポートは環境変数で上書きできる。
```bash
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
APP_URL="http://127.0.0.1:8766/" node ./run_test.mjs
```

## カバーしている範囲

| セクション | 内容 |
|---|---|
| [1] 初期表示・ナビ | 3ビューの `hidden` 切替、履歴0件時の表示 |
| [2] 設定（APIキー） | 未設定時の設定画面への誘導、空入力の拒否、保存/クリア、**リロードしても入力欄に実値を戻さない** |
| [3] 設定（読み上げ） | 声の一覧（日本語優先の並び）、速度スライダー、自動再生、モデル選択、テスト再生 |
| [4] ダイジェスト生成 | Geminiをモックして生成→表示→保存、**分割された `parts` の連結**、自動再生OFFの尊重 |
| [5] XSS | 生成本文に含まれる `<img onerror>` がスクリプトとして実行されないこと |
| [6] 読み上げ | チャンク分割再生、開始/一時停止/再開/停止のUI遷移、`lang=ja-JP` |
| [7] チャンク分割 | 空文字、句点分割の可逆性（文字が失われない）、maxLen超過時の強制分割 |
| [8] 履歴 | 7件への切り詰め、同日付の上書き、開く/削除/全削除、**開いただけでは読み上げない** |
| [9] エラー処理 | 403のときエラー表示を消さずに残し、ボタンが操作可能に戻ること |
| [10] APIキーの取り扱い | `type=password`、URLクエリに載らない、`x-goog-api-key` ヘッダーで送る |
| [11] PWA | manifest / icons / sw.js が配信できること |

**テストは実データもオーナーの本物のAPIキーも一切使わない**（すべてテスト内で作る架空の文字列）。

## テストを書くときの落とし穴（実際に踏んだもの）

- **`window.speechSynthesis` は getter のみのアクセサ。** 素の代入（`window.speechSynthesis = mock`）は
  非strictモードだと**例外も出さずに黙って失敗し**、端末の本物の音声（Microsoft Ayumi 等）が出てくる。
  必ず `Object.defineProperty(window, 'speechSynthesis', { value: mock, configurable: true })` を使う。
  `SpeechSynthesisUtterance` も同様にしておくと安全
- `page.evaluate(() => localStorage.clear())` は `about:blank` では `SecurityError` になる。
  最初の `clearAll()` の前に必ず一度 `page.goto()` しておく
- Gemini APIのモックは **OPTIONS（CORSプリフライト）にも応答が必要**。
  `Content-Type: application/json` のPOSTは必ずプリフライトされる
- モックが即座に応答すると生成が一瞬で終わり、ローディング表示が出ている瞬間を捕まえられない。
  ハンドラに数百msの遅延を入れる
- APIキー検証のテストで `req.continue()` にすると**本物のGemini APIへダミーキーで飛ぶ**。
  URL・ヘッダーを記録したうえで必ずモック応答を返すこと
- 読み上げ完了の判定に `speechSynthesis.speaking` を使わない。
  チャンクの繋ぎ目で一瞬 false になる。アプリ側のUI（`#btn-speak` の再表示）を待つ
- `speech.stop()` はアプリ内の複数箇所（`showDigest()` / `speak()` の冒頭）から呼ばれる。
  `cancel()` の回数を固定値でアサートしない
- 日付の期待値に `toISOString().slice(0,10)` を使わない（UTCなので朝9時前は前日になる）
- `page.waitForTimeout` は新しいPuppeteerで削除済み。自前の `wait(ms)` を使う
