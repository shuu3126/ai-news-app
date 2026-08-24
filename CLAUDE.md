# ai-news-app 固有ルール（作業前に必ず読む）

## このプロジェクトの位置づけ
**オーナー個人の情報収集ツール。受託案件ではない。**
毎朝のAI関連ニュースをGemini APIで収集・濃縮し、ブラウザのWeb Speech APIで
読み上げさせるPWA。PC・スマホの両方（Chrome）で動く。

設計思想は `../kakeibo-app` と**完全に同じ**。迷ったらkakeibo-appの実装を見る。

## 絶対禁止
1. **APIキーをソースに書かない。** 設定画面 → localStorage が唯一の保管場所。
   `config.js` などに書き足さない。リポジトリ内の全ファイルに `AIza...` / `AQ....` を
   ハードコードしない（CIで検査している）。
2. **会社の `GEMINI_API_KEY`（環境変数）をこのアプリに流用しない。**
   このアプリはリファラー制限付きの専用キーを使う。
3. **ユーザー入力・API生成テキストを `innerHTML` に入れない。** 必ず `textContent`。
   ニュース本文はGeminiが生成した外部由来の文字列なので、XSSの入力面として扱う。
4. **push・デプロイはオーナーの明示的な指示があるときだけ。**
   GitHubリポジトリの作成もオーナー判断（2026-08-24時点で未作成・ローカルのみ）。

## 技術的な制約
- 素のHTML/CSS/JS（ESモジュール）のみ。ビルドツール・npm依存・外部CDNを**入れない**
- パスはすべて相対（`./` 始まり）。GitHub Pages のサブパス配信でも動かすため
- 日付の `YYYY-MM-DD` 生成に `toISOString()` を使わない（UTCズレで前日になる）。
  ローカル時刻で組み立てる（`storage.js` の `getLocalDateString()`）
- 表示制御は `hidden` 属性 + CSS `[hidden] { display: none !important }` に統一する。
  `.view:not(.active) { display:none }` のようなクラス依存の指定を混ぜない
- ファイルを変更したら `sw.js` の `CACHE_NAME` のバージョンを上げる
- Service Worker は network-first。App Shellだけキャッシュする

## Gemini API の呼び方（kakeibo-app と同じ）
- エンドポイント: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- APIキーは **`x-goog-api-key` ヘッダー**で渡す。**URLのクエリに入れない**
  （クエリだとRefererやログ・履歴にキーが残る）
- 1段階目のニュース収集だけ `tools: [{ google_search: {} }]` を付ける。
  2段階目のナレーション整形は検索不要なので付けない
- **grounding付きのレスポンスは `parts` が複数に分かれる。**
  `parts[0].text` だけを読むと本文が途中で切れる。`parts` 全部の `.text` を連結すること

## Web Speech API の落とし穴（既知・必ず対応する）
- **長文を1つの `SpeechSynthesisUtterance` に渡すと途中で止まる。**
  句点（。！？改行）で分割して1つずつキューイングし、`onend` で次を再生する
- Chromeは読み上げ開始から約15秒で無音停止することがある。
  読み上げ中は `speechSynthesis.pause(); speechSynthesis.resume();` を
  10秒間隔で打って回避する（keep-alive）
- `speechSynthesis.getVoices()` は**初回に空配列を返す**。
  `voiceschanged` イベントを待つ。イベントが来ない環境もあるのでタイムアウトも用意する
- 停止は `speechSynthesis.cancel()`。cancelすると残りの utterance の `onend` も発火するため、
  「自分が意図的に止めたのか」を示すフラグを持たないと次のチャンクが再生され続ける
- タブが非アクティブ／画面遷移で読み上げが止まる場合があることをUIに注意書きする

## データ
- localStorage のみ。Drive同期・ファイル同期は**入れない**（個人情報を扱わないため不要）
- `ainews.settings.v1` … APIキー・声・速度・モデル
- `ainews.digests.v1` … 直近7日分のダイジェスト本文（それ以上は古い順に捨てる）

## 動作確認の手順
```bash
cd "G:/マイドライブ/2.副業/ai-news-app"
python -m http.server 8766 --bind 127.0.0.1
```
Chrome で http://127.0.0.1:8766/ を開く。

自動テストは `tests/README.md` を参照。
Gemini APIは Puppeteer の request interception でモックする
（**OPTIONSプリフライトにも応答が必要**。Content-Type: application/json のPOSTは必ずプリフライトされる）。
`speechSynthesis` はヘッドレスChromeでは実際に音が出ないため、
`page.evaluateOnNewDocument()` で差し替えたモックを使う。

## 元になったプロトタイプ
`../.company/tools/ai_news_digest.py`（Python + google-genai SDK版・動作確認済み）。
プロンプト文面はここから移植した。**分量目標だけ 800〜1400字 → 5000〜6000字に変更している**
（オーナー要望：15分程度で聞ける分量）。Python版を直す場合はこちらのプロンプトと揃えること。
