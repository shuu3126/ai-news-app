import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.APP_URL || 'http://127.0.0.1:8766/';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  FAIL ${name} ${extra}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox']
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900 });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

// confirm() は常に true を返す（削除確認ダイアログでテストが止まらないように）
page.on('dialog', async d => { await d.accept(); });

// speechSynthesis のモック
await page.evaluateOnNewDocument(() => {
  window.__spoken = [];
  window.__lastUtterance = null;
  window.__cancelCount = 0;
  window.__timers = [];

  class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = '';
      this.rate = 1;
      this.pitch = 1;
      this.voice = null;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this._cancelled = false; // キャンセルされたかどうかのフラグ
    }
  }
  // window.SpeechSynthesisUtterance / window.speechSynthesis は
  // Window.prototype 上の「getterのみ」のアクセサなので、素の代入は非strictモードだと
  // 例外も出さずに黙って失敗する（実際のWindows音声が出てきてテストが壊れる）。
  // 必ず Object.defineProperty で上書きすること。
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: MockSpeechSynthesisUtterance, writable: true, configurable: true
  });

  const mockSynth = {
    speaking: false,
    paused: false,
    pending: false, // Puppeteerではpendingのテストはしないが、プロパティは定義
    getVoices: () => [
      { voiceURI: 'mock-ja', name: 'Mock 日本語', lang: 'ja-JP', localService: true, default: true },
      { voiceURI: 'mock-en', name: 'Mock English', lang: 'en-US', localService: true, default: false }
    ],
    speak: (u) => {
      if (u._cancelled) return; // キャンセル済みなら何もしない
      window.__spoken.push(u.text);
      window.__lastUtterance = u;
      window.speechSynthesis.speaking = true;

      const startTimer = setTimeout(() => {
        if (u._cancelled) return;
        u.onstart?.();
        const endTimer = setTimeout(() => {
          if (u._cancelled) return;
          window.speechSynthesis.speaking = false;
          u.onend?.();
        }, 15);
        window.__timers.push(endTimer);
      }, 5);
      window.__timers.push(startTimer);
    },
    cancel: () => {
      window.__cancelCount++;
      window.speechSynthesis.speaking = false;
      window.speechSynthesis.paused = false;
      window.__timers.forEach(clearTimeout);
      window.__timers = [];
      // 現在話している可能性のあるutteranceをキャンセル状態にする
      if (window.__lastUtterance) {
        window.__lastUtterance._cancelled = true;
      }
    },
    pause: () => { window.speechSynthesis.paused = true; },
    resume: () => { window.speechSynthesis.paused = false; },
    addEventListener: () => {}, // 何もしない
    removeEventListener: () => {} // 何もしない
  };
  Object.defineProperty(window, 'speechSynthesis', {
    value: mockSynth, writable: true, configurable: true
  });
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function reload() {
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(300);
}
async function clearAll() {
  // about:blank では localStorage にアクセスできず SecurityError になる。
  // まだアプリを開いていなければ先に開く。
  if (!page.url().startsWith(URL)) await reload();
  await page.evaluate(() => localStorage.clear());
  await reload();
}
// 下部ナビ（position: fixed / 高さ60px）に隠れた要素をクリックできるよう
// scrollIntoView してから click する
const click = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (e) {
    e.scrollIntoView({ block: 'center' });
    e.click();
  } else {
    throw new Error(`Element not found for selector: ${s}`);
  }
}, sel);
const setValue = (sel, value) => page.evaluate((s, v) => {
  const e = document.querySelector(s);
  if (e) {
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    throw new Error(`Element not found for selector: ${s}`);
  }
}, sel, value);
const text   = (sel) => page.$eval(sel, e => e.textContent);
const hidden = (sel) => page.$eval(sel, e => e.hidden);
const attr   = (sel, name) => page.$eval(sel, (e, n) => e.getAttribute(n), name);
const prop   = (sel, name) => page.$eval(sel, (e, n) => e[n], name);
const exists = async (sel) => (await page.$(sel)) !== null;

// アプリのローディング表示を観測できるよう、POSTの応答をわざと遅らせる。
// 即座に返すと生成が一瞬で終わり、#generate-status が出ている瞬間を捉えられない。
const MOCK_LATENCY_MS = 400;

const makeGeminiHandler = (bodyText, status = 200) => async (req) => {
  const url = req.url();
  if (url.includes('generativelanguage.googleapis.com')) {
    if (req.method() === 'POST') {
      await new Promise(r => setTimeout(r, MOCK_LATENCY_MS));
    }
    if (req.method() === 'OPTIONS') {
      return req.respond({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS'
        }
      });
    }
    if (req.method() === 'POST') {
      if (status !== 200) {
        return req.respond({
          status: status,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: { code: status, message: 'Test error message' } })
        });
      }
      // grounding有効時は parts が複数に分かれる。アプリが全partsを連結できるか検証するため
      // わざと2つに分けて返す。
      const part1 = bodyText.slice(0, Math.floor(bodyText.length / 2));
      const part2 = bodyText.slice(Math.floor(bodyText.length / 2));
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: part1 }, { text: part2 }] },
                         finishReason: 'STOP' }]
        })
      });
    }
  }
  return req.continue();
};

const TEST_TEXT_BASE = `
これはテスト用の記事です。AIニュースアプリの自動テストのために作成されました。
この文章は、日本語の句読点「。」を多く含んでいます。
これにより、読み上げ時のチャンク分割が正しく行われるかを確認できます。
テストは、アプリケーションの様々な機能を網羅するように設計されています。
例えば、APIキーの設定、読み上げ機能、履歴の管理、エラー処理などです。
この長い文章は、チャンク分割ロジックが正しく動作するかを検証するのに役立ちます。
また、XSS脆弱性がないかどうかの確認も行われます。
セキュリティは非常に重要であり、ユーザーが入力したデータやAPIから取得したデータが
安全に表示されることを保証する必要があります。
このテストテキストは、700文字以上の長さを持つように意図的に長くしています。
これにより、長文の処理能力も検証できます。
句読点がない場合でも、一定の文字数で強制的に分割されることも確認します。
全ての機能が期待通りに動作することを確認することが、このテストの目的です。
`;
// アプリ側は受け取った原稿を _cleanNarration() で trim し、行頭のMarkdown記号を落とす。
// テキストが加工されると includes() 判定が壊れるので、
// 「改行なし・前後の空白なし・Markdown記号なし」の1本の文字列にしてから使う。
const TEST_TEXT_700_CHARS = TEST_TEXT_BASE
  .replace(/\s+/g, '')
  .repeat(3)
  .slice(0, 700);

// [1] 初期表示とナビゲーション
console.log('\n[1] 初期表示とナビゲーション');
await clearAll();
ok('メインビューが初期表示されている', !(await hidden('#view-main')));
ok('履歴ビューがhidden', await hidden('#view-history'));
ok('設定ビューがhidden', await hidden('#view-settings'));
ok('生成ボタンが存在する', await exists('#btn-generate'));
ok('ダイジェストパネルは初期状態ではhidden', await hidden('#digest-panel'));

await click('.nav-btn[data-view="settings"]');
ok('設定ビューが表示された', !(await hidden('#view-settings')));
ok('メインビューがhiddenになった', await hidden('#view-main'));

await click('.nav-btn[data-view="history"]');
ok('履歴ビューが表示された', !(await hidden('#view-history')));
ok('設定ビューがhiddenになった', await hidden('#view-settings'));
ok('履歴が0件のとき #history-empty が表示される', !(await hidden('#history-empty')));
ok('履歴が0件のとき #btn-clear-history は hidden', await hidden('#btn-clear-history'));

// [2] 設定（APIキー）
console.log('\n[2] 設定（APIキー）');
await clearAll();
await click('.nav-btn[data-view="main"]'); // メインビューに戻る

// APIキー未設定で生成ボタンを押すと設定ビューへ自動遷移
await click('#btn-generate');
ok('APIキー未設定で生成ボタンを押すと設定ビューへ自動遷移', !(await hidden('#view-settings')));
ok('APIキー入力欄が存在する', await exists('#api-key'));

// 空文字のまま保存
await click('#btn-save-key');
ok('空キー保存で #api-key-status が表示される', !(await hidden('#api-key-status')));
ok('空キー保存で #api-key-status に .status-error クラスが付く', (await attr('#api-key-status', 'class')).includes('status-error'));

// 有効なキーを保存
const TEST_API_KEY = 'AQ.test-dummy-key-for-automated-tests';
await setValue('#api-key', TEST_API_KEY);
await click('#btn-save-key');
await wait(100); // UI更新を待つ

const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('localStorageにAPIキーが保存された', settings.geminiApiKey, TEST_API_KEY);
eq('#api-key の value が空に戻る', await prop('#api-key', 'value'), '');
eq('#api-key の placeholder が変更される', await attr('#api-key', 'placeholder'), '保存済み（変更する場合のみ入力）');
ok('#api-key-status に .status-success が付く', (await attr('#api-key-status', 'class')).includes('status-success'));

// リロードしても #api-key の value は空のまま
await reload();
await click('.nav-btn[data-view="settings"]');
eq('リロード後も #api-key の value は空のまま', await prop('#api-key', 'value'), '');
eq('リロード後も #api-key の placeholder は変更されたまま', await attr('#api-key', 'placeholder'), '保存済み（変更する場合のみ入力）');

// APIキーをクリア
await click('#btn-clear-key');
await wait(100);
const clearedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('APIキーがクリアされた', clearedSettings.geminiApiKey, '');
eq('クリア後 #api-key の placeholder が初期状態に戻る', await attr('#api-key', 'placeholder'), 'AIza... または AQ....');

// [3] 設定（読み上げ）
console.log('\n[3] 設定（読み上げ）');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key }));
}, TEST_API_KEY);
await reload();
await click('.nav-btn[data-view="settings"]');

const voiceOptions = await page.$$eval('#voice-select option', options => options.map(o => o.value));
eq('#voice-select の option の value 一覧が正しい', voiceOptions, ['', 'mock-ja', 'mock-en']);

await setValue('#rate-range', '1.5');
eq('#rate-value の textContent が 1.5', await text('#rate-value'), '1.5');
const settingsAfterRate = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('localStorage の rate が 1.5 になる', settingsAfterRate.rate, 1.5);

// autoPlay の既定値は DEFAULT_SETTINGS の true。クリックで反転することを見る
const autoPlayBefore = await prop('#auto-play', 'checked');
await click('#auto-play');
await wait(50);
const settingsAfterAutoPlay = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('autoPlay がクリックで反転して保存される', settingsAfterAutoPlay.autoPlay, !autoPlayBefore);

await setValue('#model-select', 'gemini-2.5-pro');
const settingsAfterModel = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('model が gemini-2.5-pro になる', settingsAfterModel.model, 'gemini-2.5-pro');

await page.evaluate(() => window.__spoken = []); // テスト前にクリア
await click('#btn-test-speak');
await wait(50); // 読み上げ開始を待つ
const spokenLength = await page.evaluate(() => window.__spoken.length);
ok('#btn-test-speak を押すと window.__spoken の長さが1以上になる', spokenLength >= 1);

// [4] ダイジェスト生成（Geminiモック）
console.log('\n[4] ダイジェスト生成（Geminiモック）');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false }));
}, TEST_API_KEY);
await reload();

const geminiHandler = makeGeminiHandler(TEST_TEXT_700_CHARS);
await page.setRequestInterception(true);
page.on('request', geminiHandler);

await click('#btn-generate');
ok('生成開始後 #generate-status が表示される', !(await hidden('#generate-status')));
ok('生成開始後 #btn-cancel-generate が表示される', !(await hidden('#btn-cancel-generate')));

await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#digest-panel'
);
await wait(500); // アニメーションとUI更新を待つ

ok('#digest-panel が hidden でなくなった', !(await hidden('#digest-panel')));
const digestTextContent = await text('#digest-text');
ok('#digest-text の textContent が TEST_TEXT を含む', digestTextContent.includes(TEST_TEXT_700_CHARS));
ok('partsが2つに分かれていても全部連結されている', digestTextContent.length >= TEST_TEXT_700_CHARS.length);

// toISOString() はUTCなので日本時間の朝9時前だと前日になる。ローカル時刻で組み立てる。
const _now = new Date();
const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
ok('#digest-meta に今日の日付が含まれる', (await text('#digest-meta')).includes(today));

const digests = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.digests.v1')));
eq('localStorage にダイジェストが1件保存された', digests.length, 1);
ok('保存されたダイジェストの text が TEST_TEXT を含む', digests[0].text.includes(TEST_TEXT_700_CHARS));

ok('#generate-status が最終的に hidden に戻っている', await hidden('#generate-status'));
ok('#btn-cancel-generate が最終的に hidden に戻っている', await hidden('#btn-cancel-generate'));

const spokenAfterGenerate = await page.evaluate(() => window.__spoken);
eq('autoPlay が false なので window.__spoken は空のまま', spokenAfterGenerate.length, 0);

page.off('request', geminiHandler);
await page.setRequestInterception(false);

// [5] XSS
console.log('\n[5] XSS');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false }));
}, TEST_API_KEY);
await reload();

const XSS_PAYLOAD = `<img src=x onerror="window.__xss=1">`;
const XSS_TEST_TEXT = `これはXSSテストです。${XSS_PAYLOAD}スクリプトが実行されないことを確認します。`;
const xssGeminiHandler = makeGeminiHandler(XSS_TEST_TEXT);
await page.setRequestInterception(true);
page.on('request', xssGeminiHandler);

await page.evaluate(() => window.__xss = undefined); // XSSフラグをリセット
await click('#btn-generate');
await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#digest-panel'
);
await wait(500);

const xssFlag = await page.evaluate(() => window.__xss);
eq('window.__xss が undefined のまま（スクリプトが実行されない）', xssFlag, undefined);

const digestTextWithXSS = await text('#digest-text');
ok('#digest-text の textContent に <img が文字列として含まれる', digestTextWithXSS.includes('<img'));

await click('.nav-btn[data-view="history"]');
const historyPreviewWithXSS = await text('.history-item .history-preview');
ok('履歴の .history-preview にも文字列として入る', historyPreviewWithXSS.includes('<img'));

page.off('request', xssGeminiHandler);
await page.setRequestInterception(false);

// [6] 読み上げ
console.log('\n[6] 読み上げ');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false, voiceURI: 'mock-ja' }));
}, TEST_API_KEY);
await reload();

const speakGeminiHandler = makeGeminiHandler(TEST_TEXT_700_CHARS);
await page.setRequestInterception(true);
page.on('request', speakGeminiHandler);

await click('#btn-generate');
await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#digest-panel'
);
await wait(500);

await page.evaluate(() => window.__spoken = []); // 読み上げ記録をクリア
await page.evaluate(() => window.__cancelCount = 0); // キャンセルカウントをクリア

await click('#btn-speak');
ok('#btn-speak が hidden になる', await hidden('#btn-speak'));
ok('#btn-pause が表示される', !(await hidden('#btn-pause')));
ok('#btn-stop が表示される', !(await hidden('#btn-stop')));

await wait(100); // 読み上げ開始を待つ
eq('window.__lastUtterance.lang が ja-JP', await page.evaluate(() => window.__lastUtterance.lang), 'ja-JP');

// 読み上げは1チャンクずつ順番に再生されるので、全部終わるまで待つ。
// speechSynthesis.speaking はチャンクの繋ぎ目で一瞬 false になるため判定に使えない。
// アプリが onEnd で #btn-speak を出し直すのを待つ。
await page.waitForFunction(() => !document.querySelector('#btn-speak').hidden, { timeout: 15000 });

const spokenChunks = await page.evaluate(() => window.__spoken);
ok('window.__spoken に複数のチャンクが入る', spokenChunks.length > 1);
ok('window.__spoken.join("") が元テキスト全体を復元する',
   spokenChunks.join('') === TEST_TEXT_700_CHARS,
   `spoken=${spokenChunks.join('').length}文字 / expected=${TEST_TEXT_700_CHARS.length}文字`);
ok('読み上げが最後まで進むと #btn-speak が再表示される', !(await hidden('#btn-speak')));
ok('読み上げが最後まで進むと #btn-pause が hidden に戻る', await hidden('#btn-pause'));
ok('読み上げが最後まで進むと #btn-stop が hidden に戻る', await hidden('#btn-stop'));

// 途中で停止
await click('#btn-generate'); // 新しいダイジェストを生成して読み上げ状態をリセット
await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#digest-panel'
);
await wait(500);
await page.evaluate(() => window.__cancelCount = 0);
await click('#btn-speak');
await wait(50); // 読み上げ開始を待つ
await click('#btn-stop');
await wait(50); // 停止処理を待つ

// アプリは showDigest() や speak() の冒頭でも stop() を呼ぶので、
// 回数を1に固定せず「増えたこと」を見る
ok('途中で #btn-stop を押すと window.__cancelCount が増える',
   (await page.evaluate(() => window.__cancelCount)) >= 1);
ok('停止後UIが初期状態に戻る (#btn-speak表示)', !(await hidden('#btn-speak')));
ok('停止後UIが初期状態に戻る (#btn-pause hidden)', await hidden('#btn-pause'));
ok('停止後UIが初期状態に戻る (#btn-stop hidden)', await hidden('#btn-stop'));

// 一時停止と再開
await click('#btn-speak');
await wait(50);
await click('#btn-pause');
eq('一時停止後 #btn-pause の dataset.state が paused', await attr('#btn-pause', 'data-state'), 'paused');
eq('一時停止後 #btn-pause の textContent が 再開', await text('#btn-pause'), '再開');
await click('#btn-pause'); // 再開
eq('再開後 #btn-pause の dataset.state が playing', await attr('#btn-pause', 'data-state'), 'playing');
eq('再開後 #btn-pause の textContent が 一時停止', await text('#btn-pause'), '一時停止');
await click('#btn-stop'); // 停止してクリーンアップ

ok('#speech-note が画面に存在する', await exists('#speech-note'));

page.off('request', speakGeminiHandler);
await page.setRequestInterception(false);

// [7] チャンク分割ロジック（speech.js を直接呼ぶ）
console.log('\n[7] チャンク分割ロジック');
await clearAll();

const splitIntoChunks = async (text) => {
  return await page.evaluate(async (t) => {
    const { splitIntoChunks } = await import('./js/speech.js');
    return splitIntoChunks(t);
  }, text);
};

eq('splitIntoChunks("") が []', await splitIntoChunks(''), []);

const testTextWithPeriods = 'あいうえお。かきくけこ。さしすせそ。たちつてと。';
const chunksWithPeriods = await splitIntoChunks(testTextWithPeriods);
eq('句点あり文字列の全要素を連結すると元の文字列と一致する', chunksWithPeriods.join(''), testTextWithPeriods);
ok('各チャンクが maxLen (120) 以下である', chunksWithPeriods.every(c => c.length <= 120));
ok('句点「。」がチャンク末尾に残っている', chunksWithPeriods.every(c => c.endsWith('。')));

const longTextNoPeriods = 'あ'.repeat(300);
const chunksNoPeriods = await splitIntoChunks(longTextNoPeriods);
ok('300文字の句点なし文字列を渡しても、全要素が maxLen (120) 以下に収まる', chunksNoPeriods.every(c => c.length <= 120));
eq('句点なし文字列の全要素を連結すると元の文字列と一致する', chunksNoPeriods.join(''), longTextNoPeriods);

// [8] 履歴
console.log('\n[8] 履歴');
await clearAll();

const storage = await page.evaluate(async () => (await import('./js/storage.js')));

// 9件のダミー履歴を直接 localStorage に入れる
const dummyDigests = [];
for (let i = 0; i < 9; i++) {
  dummyDigests.push({
    id: `dummy-${i}`,
    date: `2023-01-${String(i + 1).padStart(2, '0')}`,
    createdAt: Date.now() - (9 - i) * 1000 * 60 * 60 * 24,
    text: `ダミー記事 ${i + 1}。これはテスト用のダミー記事です。`,
    charCount: 50
  });
}
await page.evaluate((digests) => {
  localStorage.setItem('ainews.digests.v1', JSON.stringify(digests));
}, dummyDigests);

// saveDigest() でもう1件足し、7件に切り詰められることを確認
const newDigestText = '新しい記事。これは7件に切り詰められるか確認する記事です。';
await page.evaluate(async (text) => {
  const { saveDigest } = await import('./js/storage.js');
  await saveDigest({ text: text, charCount: text.length });
}, newDigestText);

const loadedDigestsAfterAdd = await page.evaluate(async () => {
  const { loadDigests } = await import('./js/storage.js');
  return loadDigests();
});
eq('loadDigests().length が 7', loadedDigestsAfterAdd.length, 7);
ok('新しい記事が追加されている', loadedDigestsAfterAdd[0].text.includes(newDigestText));

// 同じ日付で2回 saveDigest() すると件数が増えない（上書きされる）
const overwriteText = '上書きされた記事。';
await page.evaluate(async (text) => {
  const { saveDigest } = await import('./js/storage.js');
  await saveDigest({ text: text, charCount: text.length });
}, overwriteText);

const loadedDigestsAfterOverwrite = await page.evaluate(async () => {
  const { loadDigests } = await import('./js/storage.js');
  return loadDigests();
});
eq('同じ日付で上書きしても件数が増えない', loadedDigestsAfterOverwrite.length, 7);
ok('記事が上書きされている', loadedDigestsAfterOverwrite[0].text.includes(overwriteText));

await reload();
await click('.nav-btn[data-view="history"]');
const historyItemCount = await page.$$eval('.history-item', items => items.length);
eq('履歴ビューの .history-item の数が loadDigests().length と一致する', historyItemCount, 7);

// .btn-open を押すとメインビューへ切り替わり #digest-text にその本文が入る
const firstDigestId = loadedDigestsAfterOverwrite[0].id;
await click(`.history-item .btn-open[data-id="${firstDigestId}"]`);
ok('履歴から開くとメインビューへ切り替わる', !(await hidden('#view-main')));
ok('履歴から開いた記事の本文が #digest-text に入る', (await text('#digest-text')).includes(overwriteText));
eq('開いただけでは読み上げが始まらない', await page.evaluate(() => window.__spoken.length), 0);

// .btn-delete を押すと1件減る
await click('.nav-btn[data-view="history"]');
const secondDigestId = loadedDigestsAfterOverwrite[1].id;
await click(`.history-item .btn-delete[data-id="${secondDigestId}"]`);
await wait(100); // UI更新を待つ
const historyItemCountAfterDelete = await page.$$eval('.history-item', items => items.length);
eq('.btn-delete を押すと1件減る', historyItemCountAfterDelete, 6);

// #btn-clear-history を押すと0件になり #history-empty が表示される
await click('#btn-clear-history');
await wait(100);
ok('#btn-clear-history を押すと0件になる', !(await exists('.history-item')));
ok('#history-empty が表示される', !(await hidden('#history-empty')));

// [9] エラー処理
console.log('\n[9] エラー処理');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false }));
}, TEST_API_KEY);
await reload();

const errorGeminiHandler = makeGeminiHandler('Error message', 403);
await page.setRequestInterception(true);
page.on('request', errorGeminiHandler);

await click('#btn-generate');
await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#generate-status'
);
await wait(500);

ok('#generate-status が hidden でない（エラーは消さずに残す）', !(await hidden('#generate-status')));
ok('#generate-status に .status-error が付く', (await attr('#generate-status', 'class')).includes('status-error'));
ok('.message-text に APIキー という文字列が含まれる', (await text('#generate-status .message-text')).includes('APIキー'));
ok('#btn-generate の disabled が false に戻っている', !(await prop('#btn-generate', 'disabled')));

const digestsAfterError = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.digests.v1')));
eq('エラー発生時に履歴が増えていない', digestsAfterError, null); // 初期状態なのでnull

page.off('request', errorGeminiHandler);
await page.setRequestInterception(false);

// [10] APIキーの取り扱い
console.log('\n[10] APIキーの取り扱い');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false }));
}, TEST_API_KEY);
await reload();

await click('.nav-btn[data-view="settings"]');
eq('#api-key の type 属性が password', await attr('#api-key', 'type'), 'password');

const sessionStorageKeys = await page.evaluate(() => Object.keys(sessionStorage));
eq('sessionStorage にキーが残っていない', sessionStorageKeys.length, 0);

const interceptedRequests = [];
// URL・ヘッダーを記録しつつ、モック応答を返す。
// req.continue() にすると本物のGemini APIへダミーキーで飛んでしまい、
// 生成が失敗して #digest-panel が開かない（＝テストがタイムアウトする）。
const baseHandler = makeGeminiHandler(TEST_TEXT_700_CHARS);
const apiKeyCheckHandler = async (req) => {
  const url = req.url();
  if (url.includes('generativelanguage.googleapis.com') && req.method() === 'POST') {
    interceptedRequests.push({ url: url, headers: req.headers() });
  }
  return baseHandler(req);
};
await page.setRequestInterception(true);
page.on('request', apiKeyCheckHandler);

await click('.nav-btn[data-view="main"]');
await click('#btn-generate');
await page.waitForFunction(
  (selector) => document.querySelector(selector) && !document.querySelector(selector).hidden,
  {},
  '#digest-panel'
);
await wait(500);

const geminiRequest = interceptedRequests.find(r => r.url.includes('generativelanguage.googleapis.com') && r.url.includes('generateContent'));
ok('fetch のリクエストURLにAPIキーが含まれていない', !geminiRequest.url.includes('key='));
eq('リクエストヘッダに x-goog-api-key が入っている', geminiRequest.headers['x-goog-api-key'], TEST_API_KEY);

page.off('request', apiKeyCheckHandler);
await page.setRequestInterception(false);

// [11] PWA
console.log('\n[11] PWA');
await clearAll(); // PWAテストはアプリの状態に依存しないが、念のため
await reload();

eq('link[rel=manifest] の href が ./manifest.webmanifest', await attr('link[rel=manifest]', 'href'), './manifest.webmanifest');

const manifest = await page.evaluate(async () => {
  const response = await fetch('./manifest.webmanifest');
  if (!response.ok) throw new Error('Failed to fetch manifest');
  return response.json();
});
ok('manifest.webmanifest を fetch して JSON パースできる', manifest !== null);
eq('manifest.webmanifest の start_url が ./', manifest.start_url, './');
ok('manifest.webmanifest の icons が2件以上ある', manifest.icons && manifest.icons.length >= 2);

const swResponse = await page.goto(`${URL}sw.js`, { waitUntil: 'domcontentloaded' });
eq('sw.js が 200 で取得できる', swResponse.status(), 200);


console.log(`\n==== 結果: ${pass} PASS / ${fail} FAIL ====`);
if (failures.length) { console.log('失敗一覧:'); failures.forEach(f => console.log('  - ' + f)); }
// [9] エラー処理はわざと403を返させているので、そこで出るエラーは想定内として除外する
const EXPECTED_ERROR_PATTERNS = [
  'favicon', 'Service Worker', 'Test error message',
  '403 (Forbidden)', 'Gemini APIエラー詳細', 'ダイジェスト生成エラー'
];
const fatal = consoleErrors.filter(e => !EXPECTED_ERROR_PATTERNS.some(p => e.includes(p)));
if (fatal.length) { console.log('\nコンソールエラー:'); fatal.forEach(e => console.log('  ! ' + e)); }
await browser.close();
process.exit(fail > 0 ? 1 : 0);