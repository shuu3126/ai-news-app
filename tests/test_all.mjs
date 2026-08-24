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
      this.volume = 1;
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

// [12] 音量調整
console.log('\n[12] 音量調整');
// 直前の [11] で sw.js へ遷移しているので、必ずアプリへ戻してから localStorage を触る
await reload();
await clearAll();
await click('.nav-btn[data-view="settings"]');

eq('#volume-range の初期値が 1', await prop('#volume-range', 'value'), '1');
eq('#volume-value の初期表示が 100%', await text('#volume-value'), '100%');

await setValue('#volume-range', '0.4');
await wait(50);
const settingsAfterVolume = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('音量が localStorage に保存される', settingsAfterVolume.volume, 0.4);
eq('#volume-value の表示が 40% になる', await text('#volume-value'), '40%');

await reload();
await click('.nav-btn[data-view="settings"]');
eq('リロード後も音量スライダーが復元される', await prop('#volume-range', 'value'), '0.4');
eq('リロード後も音量表示が復元される', await text('#volume-value'), '40%');

// テスト再生に volume が渡っているか（speechSynthesis のモックが utterance を記録している）
await page.evaluate(() => { window.__spoken = []; window.__lastUtterance = null; });
await click('#btn-test-speak');
await wait(80);
const testSpeakUtterance = await page.evaluate(() => ({
  volume: window.__lastUtterance?.volume,
  rate: window.__lastUtterance?.rate
}));
eq('テスト再生の utterance に設定した音量が渡る', testSpeakUtterance.volume, 0.4);
eq('音量を変えても速度は既定のまま', testSpeakUtterance.rate, 1);

// 範囲外の値は storage 側でクランプされる
const clampedVolume = await page.evaluate(async () => {
  const s = await import('./js/storage.js');
  s.setSetting('volume', 5);
  return s.getSetting('volume');
});
eq('範囲外の音量は 1.0 にクランプされる', clampedVolume, 1);

// [13] テーマの手動切り替え
console.log('\n[13] テーマの手動切り替え');
await clearAll();
await click('.nav-btn[data-view="settings"]');

eq('#theme-select の初期値が auto', await prop('#theme-select', 'value'), 'auto');
eq('auto のとき body に data-theme が付いていない',
  await page.evaluate(() => document.body.dataset.theme), undefined);

await setValue('#theme-select', 'dark');
await wait(50);
eq('dark を選ぶと body[data-theme=dark] になる',
  await page.evaluate(() => document.body.dataset.theme), 'dark');

await reload();
eq('リロード後も dark が保たれる',
  await page.evaluate(() => document.body.dataset.theme), 'dark');

await click('.nav-btn[data-view="settings"]');
await setValue('#theme-select', 'auto');
await wait(50);
eq('auto に戻すと data-theme 属性そのものが外れる（@media を効かせるため）',
  await page.evaluate(() => document.body.dataset.theme), undefined);
ok('auto に戻したとき data-theme 属性が空文字で残っていない',
  await page.evaluate(() => !document.body.hasAttribute('data-theme')));

// --- ダークモードの生成中バナーが白く浮かないこと（カスケード順の回帰テスト） ---
// ダーク用の上書きをCSS冒頭の @media に書くと、後ろに出てくる同一詳細度の
// ライト用ルールに打ち消される。実際に一度それで壊れたので、色を実測して守る。
const parseRgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);

// (a) OS設定がダークのとき（@media (prefers-color-scheme: dark)）
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await reload();
const osDarkColors = await page.evaluate(() => {
  const s = document.querySelector('#generate-status');
  s.hidden = false; s.className = 'status-message status-loading';
  const bg = getComputedStyle(s).backgroundColor;
  const panelBorder = getComputedStyle(document.querySelector('#digest-panel')).borderTopWidth;
  s.hidden = true;
  return { bg, panelBorder, bodyBg: getComputedStyle(document.body).backgroundColor };
});
ok('OSダーク時に body の背景が暗い', parseRgb(osDarkColors.bodyBg)[0] < 60);
ok('OSダーク時の生成中バナーがライト固定色(#e0eaf2)のままになっていない',
  parseRgb(osDarkColors.bg)[0] < 120);
ok('OSダーク時はカードに枠線が出る（影が見えないため）',
  parseFloat(osDarkColors.panelBorder) >= 1);

// (b) 手動でダークを選んだとき（body[data-theme="dark"]）
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await reload();
const manualDarkColors = await page.evaluate(async () => {
  const s = await import('./js/storage.js');
  s.setSetting('theme', 'dark');
  document.body.dataset.theme = 'dark';
  const el = document.querySelector('#generate-status');
  el.hidden = false; el.className = 'status-message status-loading';
  const bg = getComputedStyle(el).backgroundColor;
  const panelBorder = getComputedStyle(document.querySelector('#digest-panel')).borderTopWidth;
  el.hidden = true;
  return { bg, panelBorder };
});
ok('手動ダーク時も生成中バナーが白く浮かない', parseRgb(manualDarkColors.bg)[0] < 120);
ok('手動ダーク時もカードに枠線が出る', parseFloat(manualDarkColors.panelBorder) >= 1);

// (c) OSがダークでも手動でライトを選んだらライトの見た目になる
const manualLightColors = await page.evaluate(async () => {
  const s = await import('./js/storage.js');
  s.setSetting('theme', 'light');
  document.body.dataset.theme = 'light';
  const el = document.querySelector('#generate-status');
  el.hidden = false; el.className = 'status-message status-loading';
  const bg = getComputedStyle(el).backgroundColor;
  el.hidden = true;
  return { bg, bodyBg: getComputedStyle(document.body).backgroundColor };
});
ok('手動ライト時はバナーが明るい色に戻る', parseRgb(manualLightColors.bg)[0] > 180);
ok('手動ライト時は body の背景が明るい', parseRgb(manualLightColors.bodyBg)[0] > 200);

// 以降のテストの前提を崩さないよう、テーマ設定を戻す
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await clearAll();

// [14] 読み上げ波形（イコライザー）
console.log('\n[14] 読み上げ波形（イコライザー）');
await clearAll();
await page.evaluate((key) => {
  localStorage.setItem('ainews.settings.v1', JSON.stringify({ geminiApiKey: key, autoPlay: false }));
}, 'AQ.test-dummy-key-for-automated-tests');
await reload();

await page.evaluate(() => {
  // モックの読み上げは1チャンク約20msで終わる。短い本文だと
  // 「読み上げ中」の瞬間を観測する前に onEnd が走って UI が戻ってしまうので、
  // チャンク数を稼げるだけの長さを持たせる（60文 ≒ 20チャンク ≒ 400ms）
  const longText = 'これは読み上げ波形の表示を確認するための、十分に長さのあるテスト用の文章です。'.repeat(60);
  const digest = {
    id: 'eq-test', date: '2026-08-25',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: '',
    text: longText, charCount: longText.length
  };
  localStorage.setItem('ainews.digests.v1', JSON.stringify([digest]));
});
await reload();
await click('.nav-btn[data-view="history"]');
await click('.history-item .btn-open[data-id="eq-test"]');
await wait(200);

eq('#speak-equalizer が5本の .eq-bar を持つ',
  await page.$$eval('#speak-equalizer .eq-bar', els => els.length), 5);
ok('読み上げ前は #speak-equalizer が hidden', await hidden('#speak-equalizer'));

await click('#btn-speak');
await wait(150);
ok('読み上げ中は #speak-equalizer が表示される', !(await hidden('#speak-equalizer')));
ok('読み上げ中は is-paused が付いていない',
  !(await page.$eval('#speak-equalizer', e => e.classList.contains('is-paused'))));

await click('#btn-pause');
await wait(100);
ok('一時停止すると .is-paused が付く',
  await page.$eval('#speak-equalizer', e => e.classList.contains('is-paused')));

await click('#btn-pause'); // 再開
await wait(100);
ok('再開すると .is-paused が外れる',
  !(await page.$eval('#speak-equalizer', e => e.classList.contains('is-paused'))));

await click('#btn-stop');
await wait(100);
ok('停止すると #speak-equalizer が hidden に戻る', await hidden('#speak-equalizer'));
ok('停止時に .is-paused も外れている',
  !(await page.$eval('#speak-equalizer', e => e.classList.contains('is-paused'))));

// [15] 空状態の案内・履歴の相対日付・声の表示名
console.log('\n[15] 空状態・相対日付・声の表示名');
await clearAll();
ok('ダイジェストが無いとき #main-empty が表示される', !(await hidden('#main-empty')));
ok('ダイジェストが無いとき #digest-panel は hidden', await hidden('#digest-panel'));

// 今日 / 昨日 / 3日前 のダイジェストを入れて相対表記を確認
await page.evaluate(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const mk = (id, offsetDays) => ({
    id, date: dstr(offsetDays),
    createdAt: new Date(Date.now() - offsetDays * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - offsetDays * 86400000).toISOString(),
    deletedAt: '',
    text: `${id} の本文です。テスト用のダミーです。`, charCount: 20
  });
  localStorage.setItem('ainews.digests.v1', JSON.stringify([mk('d-today', 0), mk('d-yesterday', 1), mk('d-3days', 3)]));
});
await reload();
await click('.nav-btn[data-view="history"]');
await wait(100);

const historyDates = await page.$$eval('.history-item .history-date', els => els.map(e => e.textContent));
ok('履歴の日付に「今日」が出る', historyDates.some(t => t.startsWith('今日')));
ok('履歴の日付に「昨日」が出る', historyDates.some(t => t.startsWith('昨日')));
ok('履歴の日付に「3日前」が出る', historyDates.some(t => t.startsWith('3日前')));
ok('相対表記の後ろに YYYY-MM-DD も併記されている', historyDates.every(t => /\d{4}-\d{2}-\d{2}/.test(t)));

// ボタンの強弱（開く＝primary / 削除＝ghost）
ok('「開く」が primary-btn になっている',
  await page.$eval('.history-item .btn-open', e => e.classList.contains('primary-btn')));
ok('「削除」が ghost-btn になっている（danger-btn ではない）',
  await page.$eval('.history-item .btn-delete', e => e.classList.contains('ghost-btn') && !e.classList.contains('danger-btn')));

// 声の表示名の整形
const voiceLabels = await page.$$eval('#voice-select option', els => els.map(e => ({ t: e.textContent, title: e.title, v: e.value })));
ok('声のオプションに内部名そのままの " - Japanese (Japan)" が出ていない',
  voiceLabels.every(o => !o.t.includes(' - Japanese (Japan)')));
ok('日本語の声のラベルが「（日本語）」で終わる（ロケール表記のままにしない）',
  voiceLabels.filter(o => o.v === 'mock-ja').every(o => o.t.endsWith('（日本語）')));
ok('英語の声のラベルが「（英語）」で終わる',
  voiceLabels.filter(o => o.v === 'mock-en').every(o => o.t.endsWith('（英語）')));
ok('声のオプションの value は voiceURI のまま（自動以外）',
  voiceLabels.filter(o => o.v !== '').every(o => typeof o.v === 'string' && o.v.length > 0));
ok('整形前の内部名は title 属性に残っている',
  voiceLabels.filter(o => o.v !== '').every(o => o.title && o.title.length > 0));

// [16] 論理削除と同期マージ
console.log('\n[16] 論理削除と同期マージ');
await clearAll();
await page.evaluate(() => {
  const now = new Date().toISOString();
  localStorage.setItem('ainews.digests.v1', JSON.stringify([
    { id: 'a', date: '2026-08-20', createdAt: now, updatedAt: now, deletedAt: '', text: 'Aの本文です。', charCount: 7 },
    { id: 'b', date: '2026-08-19', createdAt: now, updatedAt: now, deletedAt: '', text: 'Bの本文です。', charCount: 7 }
  ]));
});
await reload();

const afterLogicalDelete = await page.evaluate(async () => {
  const s = await import('./js/storage.js');
  s.deleteDigest('a');
  return {
    live: s.loadDigests().map(d => d.id),
    all: s.loadAllDigests().map(d => ({ id: d.id, deleted: !!d.deletedAt }))
  };
});
ok('削除したレコードは loadDigests() から消える', !afterLogicalDelete.live.includes('a'));
ok('削除したレコードは loadAllDigests() に墓標として残る',
  afterLogicalDelete.all.some(d => d.id === 'a' && d.deleted));

const afterClearAllDigests = await page.evaluate(async () => {
  const s = await import('./js/storage.js');
  s.clearDigests();
  return { live: s.loadDigests().length, all: s.loadAllDigests().length };
});
eq('clearDigests() で生きたレコードが0件になる', afterClearAllDigests.live, 0);
ok('clearDigests() は物理削除しない（墓標が残る）', afterClearAllDigests.all >= 2);

// mergeRecords の LWW と削除優先
const mergeResult = await page.evaluate(async () => {
  const { mergeRecords, toTime } = await import('./js/sync.js');
  const older = { id: 'x', updatedAt: '2026-08-20T00:00:00.000Z', deletedAt: '', text: '古い' };
  const newer = { id: 'x', updatedAt: '2026-08-21T00:00:00.000Z', deletedAt: '', text: '新しい' };
  const lww = mergeRecords([older], [newer]);

  // 文字列比較だと "...+09:00" < "...Z" で誤判定する組み合わせ
  const localFmt = { id: 'y', updatedAt: '2026-08-21T09:00:00+09:00', text: 'ローカル表記' };
  const utcFmt = { id: 'y', updatedAt: '2026-08-21T00:00:00.000Z', text: 'UTC表記' };

  // 同着なら削除を優先する
  const t = '2026-08-22T00:00:00.000Z';
  const alive = { id: 'z', updatedAt: t, deletedAt: '', text: '生存' };
  const dead = { id: 'z', updatedAt: t, deletedAt: t, text: '削除済み' };
  const tie = mergeRecords([alive], [dead]);

  return {
    lwwText: lww.merged[0].text,
    lwwFromRemote: lww.fromRemote,
    sameInstant: toTime(localFmt.updatedAt) === toTime(utcFmt.updatedAt),
    tieDeleted: !!tie.merged[0].deletedAt,
    onlyLocal: mergeRecords([older], []).merged.length,
    onlyRemote: mergeRecords([], [newer]).merged.length
  };
});
eq('mergeRecords が新しい方（リモート）を採用する', mergeResult.lwwText, '新しい');
eq('リモート由来の取り込み件数が1', mergeResult.lwwFromRemote, 1);
ok('toTime() は "+09:00" と "Z" を同じ時刻として扱う（文字列比較していない）', mergeResult.sameInstant);
ok('時刻が同着なら削除を優先する', mergeResult.tieDeleted);
eq('リモートが空でもローカルは残る', mergeResult.onlyLocal, 1);
eq('ローカルが空ならリモートを取り込む', mergeResult.onlyRemote, 1);

// buildSyncPayload は墓標込みで詰める（削除が他端末へ伝わらないと復活する）
const payloadShape = await page.evaluate(async () => {
  const { buildSyncPayload, normalizePayloadShape } = await import('./js/sync.js');
  const p = buildSyncPayload();
  return {
    app: p.app,
    hasDigests: Array.isArray(p.digests),
    includesTombstone: p.digests.some(d => !!d.deletedAt),
    fromBareArray: normalizePayloadShape([{ id: 'q' }]).digests.length,
    fromGarbage: normalizePayloadShape(null).digests.length
  };
});
eq('ペイロードの app 名が ai-news-app', payloadShape.app, 'ai-news-app');
ok('ペイロードに digests 配列がある', payloadShape.hasDigests);
ok('ペイロードに墓標が含まれている', payloadShape.includesTombstone);
eq('素の配列も digests として受け取れる', payloadShape.fromBareArray, 1);
eq('壊れたペイロードでも落ちない', payloadShape.fromGarbage, 0);

// sync() は download() の完了後にローカルを読む（待っている間の保存を消さない）
const syncOrder = await page.evaluate(async () => {
  const { initSync } = await import('./js/sync.js');
  const s = await import('./js/storage.js');
  s.replaceAllDigests([]);

  let uploaded = null;
  const controller = initSync({
    getStatus: () => ({ configured: true, signedIn: true }),
    isOnline: () => true,
    // download の待ち時間中に「別画面で保存された」状況を作る
    download: () => new Promise((resolve) => setTimeout(() => {
      s.saveDigest({ date: '2026-08-23', text: 'ダウンロード待ちの間に保存された本文です。' });
      resolve({ digests: [] });
    }, 30)),
    upload: (payload) => { uploaded = payload; return Promise.resolve(); }
  });
  const result = await controller.sync({ force: true });
  return {
    status: result.status,
    survived: s.loadDigests().some(d => d.text.includes('ダウンロード待ちの間に保存された')),
    uploadedCount: uploaded ? uploaded.digests.length : -1
  };
});
ok('ダウンロード待ちの間に保存されたデータが同期で消えない', syncOrder.survived);
ok('その分がアップロードにも載る', syncOrder.uploadedCount >= 1);

// 同期状態のUI
await clearAll();
await click('.nav-btn[data-view="settings"]');
ok('#drive-section が設定画面にある', await exists('#drive-section'));
ok('未設定のとき #drive-status に「未設定」と出る', (await text('#drive-status')).includes('未設定'));
ok('未設定のときは「今すぐ同期」が hidden', await hidden('#btn-sync-now'));
ok('未設定のときは「ログアウト」が hidden', await hidden('#btn-drive-signout'));
eq('#google-client-id の type が password', await attr('#google-client-id', 'type'), 'password');

await setValue('#google-client-id', '1234567890-abcdef.apps.googleusercontent.com');
await click('#btn-save-client-id');
await wait(150);
const settingsAfterClientId = await page.evaluate(() => JSON.parse(localStorage.getItem('ainews.settings.v1')));
eq('クライアントIDが localStorage に保存される',
  settingsAfterClientId.googleClientId, '1234567890-abcdef.apps.googleusercontent.com');
eq('保存後は入力欄に実値を残さない', await prop('#google-client-id', 'value'), '');
ok('保存後は「未ログイン」表示になり、ログインボタンが出る',
  (await text('#drive-status')).includes('未ログイン') && !(await hidden('#btn-drive-signin')));

// [17] PC幅レイアウト（最後にまとめて実施し、必ずモバイル解像度へ戻す）
console.log('\n[17] PC幅レイアウト');
await clearAll();
await page.evaluate(() => {
  const now = new Date().toISOString();
  localStorage.setItem('ainews.digests.v1', JSON.stringify([
    { id: 'r1', date: '2026-08-24', createdAt: now, updatedAt: now, deletedAt: '', text: 'レール1の本文です。', charCount: 10 },
    { id: 'r2', date: '2026-08-23', createdAt: now, updatedAt: now, deletedAt: '', text: 'レール2の本文です。', charCount: 10 }
  ]));
});

// --- モバイル幅（420px）での前提確認 ---
await reload();
const railDisplayMobile = await page.$eval('#recent-rail', e => getComputedStyle(e).display);
eq('モバイル幅では右レールが display:none', railDisplayMobile, 'none');
const navPositionMobile = await page.$eval('.bottom-nav', e => getComputedStyle(e).position);
eq('モバイル幅では下部ナビが fixed', navPositionMobile, 'fixed');

// --- PC幅（1280x800）へ ---
await page.setViewport({ width: 1280, height: 800 });
await reload();

const pcLayout = await page.evaluate(() => {
  const app = document.querySelector('#app');
  const nav = document.querySelector('.bottom-nav');
  const rail = document.querySelector('#recent-rail');
  const viewMain = document.querySelector('#view-main');
  return {
    appDisplay: getComputedStyle(app).display,
    navPosition: getComputedStyle(nav).position,
    navBottom: getComputedStyle(nav).bottom,
    railDisplay: getComputedStyle(rail).display,
    viewMainDisplay: getComputedStyle(viewMain).display,
    railLeft: rail.getBoundingClientRect().left,
    navRight: nav.getBoundingClientRect().right,
    mainLeft: document.querySelector('main').getBoundingClientRect().left
  };
});
eq('PC幅では #app が grid になる', pcLayout.appDisplay, 'grid');
eq('PC幅では下部ナビが sticky（サイドナビ）になる', pcLayout.navPosition, 'sticky');
eq('PC幅では bottom が auto に戻っている（画面下に貼り付かない）', pcLayout.navBottom, 'auto');
eq('PC幅では右レールが表示される', pcLayout.railDisplay, 'block');
eq('PC幅では #view-main が grid（本文＋右レールの2カラム）', pcLayout.viewMainDisplay, 'grid');
ok('サイドナビがメインより左にある', pcLayout.navRight <= pcLayout.mainLeft + 1);
ok('右レールが画面右側に配置されている', pcLayout.railLeft > 640);

// 右レールの中身とクリック
const railItems = await page.$$eval('#recent-rail .rail-item-btn', els => els.map(e => e.dataset.id));
eq('右レールに履歴が2件並ぶ', railItems.length, 2);
ok('右レールの空メッセージが hidden', await hidden('#recent-rail-empty'));

await click('#recent-rail .rail-item-btn[data-id="r2"]');
await wait(200);
ok('右レールから開くと本文が #digest-text に入る', (await text('#digest-text')).includes('レール2の本文'));
ok('開いた項目に .is-current が付く',
  await page.$eval('#recent-rail .rail-item-btn[data-id="r2"]', e => e.classList.contains('is-current')));
ok('PC幅でもビュー切り替え（hidden）が壊れていない', await hidden('#view-settings'));

await click('.nav-btn[data-view="settings"]');
await wait(100);
ok('PC幅でも設定ビューへ切り替えできる', !(await hidden('#view-settings')));
ok('PC幅でメインビューは hidden になる', await hidden('#view-main'));

// 1100px以上では設定が2カラム
const settingsDisplay = await page.$eval('#view-settings', e => getComputedStyle(e).display);
eq('1100px以上で設定ビューが2カラム grid になる', settingsDisplay, 'grid');

// 生成ボタンのシマークラス（クラスの付け外しだけ確認）
await click('.nav-btn[data-view="main"]');
const shimmerToggles = await page.evaluate(() => {
  const btn = document.querySelector('#btn-generate');
  btn.classList.add('is-generating');
  const on = getComputedStyle(btn).backgroundImage !== 'none';
  btn.classList.remove('is-generating');
  const off = getComputedStyle(btn).backgroundImage === 'none';
  return { on, off };
});
ok('.is-generating が付くとシマー用の background-image が入る', shimmerToggles.on);
ok('.is-generating を外すと background-image が消える', shimmerToggles.off);

// 波形のバーがPC幅で高さを持っている（scaleY だけで height が無いと見えなくなる）
const eqBarBox = await page.evaluate(() => {
  const eq = document.querySelector('#speak-equalizer');
  eq.hidden = false;
  const bar = eq.querySelector('.eq-bar');
  const r = bar.getBoundingClientRect();
  const out = { h: r.height, w: r.width };
  eq.hidden = true;
  return out;
});
ok('波形のバーに高さがある（height 未指定で潰れていない）', eqBarBox.h > 5);
ok('PC幅では波形のバーが太くなる（7px）', eqBarBox.w >= 6);

// **必ずモバイル解像度へ戻す**（戻さないと後続の前提が崩れる）
await page.setViewport({ width: 420, height: 900 });
await reload();


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