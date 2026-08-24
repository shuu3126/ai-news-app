# AIニュース読み上げ（ai-news-app）

毎朝のAI関連ニュースを Gemini API で収集・濃縮し、ブラウザの音声合成で読み上げるPWA。
作業中に「聞き流す」ための個人ツール。PC・スマホどちらのChromeでも動く。

## できること

- ボタン1つで、直近24〜48時間のAIニュースを **約15分の日本語ナレーション原稿**（5,000〜6,000字）に濃縮
- そのまま音声で読み上げ（一時停止・停止・速度変更・声の切り替え）
- 直近7日分をブラウザに保存し、いつでも聞き直せる
- ホーム画面に追加して、アプリのように起動できる（PWA）

情報源は Anthropic（Claude / Claude Code を最優先）・OpenAI・Simon Willison・Hacker News・
Import AI・TLDR AI・Ben's Bites・The Neuron。

## 使い方

1. アプリを開く
2. 「設定」タブで **Gemini APIキー** を入力して保存
   （[Google AI Studio](https://aistudio.google.com/apikey) で発行。**リファラー制限を付けた専用キーを推奨**）
3. 「ダイジェスト」タブの「本日のダイジェストを生成」を押す（1〜3分かかる）
4. 「読み上げる」を押す

設定の「生成が終わったら自動で読み上げる」をONにしておくと、生成完了後そのまま喋り始める。

### 声と速度

「設定」タブで、端末にインストールされている日本語音声から選べる。
Windowsなら Microsoft Ayumi / Haruka / Ichiro / Sayaka、
Android・iOSならOS標準の日本語音声が出てくる。速度は0.5〜2.0倍。

## 技術構成

| 項目 | 内容 |
|---|---|
| フロント | 素のHTML / CSS / JavaScript（ESモジュール）。**ビルドツール・npm依存・外部CDNなし** |
| ニュース生成 | Gemini API を**ブラウザから直接**呼ぶ（2段階）。1段階目は Google Search grounding 有効 |
| 読み上げ | Web Speech API（`window.speechSynthesis`）。サーバーサイドTTSなし |
| データ保存 | localStorage のみ。サーバーもDBも持たない |
| PWA | `manifest.webmanifest` + `sw.js`（network-first） |

```
index.html
css/style.css
js/
  app.js       … UI・イベント配線
  storage.js   … localStorage（設定・履歴）
  gemini.js    … Gemini API 呼び出しとプロンプト
  speech.js    … Web Speech API のラッパー（チャンク分割・keep-alive）
sw.js / manifest.webmanifest / icons/
tests/test_all.mjs … Puppeteer 自動テスト（92項目）
```

### 生成の流れ

1. **ニュース収集**（grounding あり）… 指定した情報源から10〜12件を検索・要約
2. **ナレーション整形**（grounding なし）… 読み上げ用の話し言葉に変換。5,000〜6,000字を指定
3. **尺の調整**（必要なときだけ）… 実測が3,500字未満なら増補、7,500字超なら短縮。
   Geminiは文字数の自己管理が苦手で放置すると1万字（約30分）まで膨らむため、生成後に実測して詰め直す

## セキュリティ

- **APIキーはソースコードに一切書かれていない。** 設定画面で入力した値が localStorage に入るだけ
- APIキーは `x-goog-api-key` **ヘッダー**で送る（URLクエリに入れない。Referer やログに残さないため）
- 生成された本文の描画はすべて `textContent`（`innerHTML` を使わない＝XSS対策）
- 扱うのはニュース本文とAPIキーだけ。個人情報を持たない

## 開発

```bash
cd "G:/マイドライブ/2.副業/ai-news-app"
python -m http.server 8766 --bind 127.0.0.1
# → http://127.0.0.1:8766/
```

自動テストは `tests/README.md` を参照。
作業前に **`CLAUDE.md`（プロジェクト固有ルール）を必ず読むこと。**

## 元になったプロトタイプ

`../.company/tools/ai_news_digest.py`（Python + google-genai SDK 版）。
プロンプトはここから移植したが、**分量目標を 800〜1,400字（3〜5分）から
5,000〜6,000字（約15分）へ変更している。**
