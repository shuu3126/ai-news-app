import * as storage from './storage.js';
import * as gemini from './gemini.js';
import * as speech from './speech.js';

/**
 * DOM要素の参照を保持するオブジェクト
 * @type {Object.<string, HTMLElement>}
 */
const els = {};

/**
 * 現在のダイジェストデータを保持する変数
 * @type {object|null}
 */
let currentDigest = null;

/**
 * ダイジェスト生成の中止に使用する AbortController
 * @type {AbortController|null}
 */
let generateAbortController = null;

/**
 * トースト表示のタイムアウトID
 * @type {number|null}
 */
let toastTimeoutId = null;

/**
 * アプリケーションの初期化
 */
document.addEventListener('DOMContentLoaded', async () => {
    // 1. 要素参照をまとめて取得
    collectDomElements();

    // 2. ナビの配線
    setupNavButtons();

    // 3. 設定を読み込み、設定画面のUIへ反映
    await loadAndApplySettings();

    // 4. Speech API のサポートチェック
    checkSpeechSupport();

    // 5. 音声一覧を読み込み、#voice-select を組み立てる
    await populateVoiceSelect();

    // 6. 履歴を描画
    renderHistory();

    // 7. 最新のダイジェストが今日の日付なら、メイン画面に自動で読み込んで表示する
    await loadTodayDigest();

    // 8. Service Worker を登録
    registerServiceWorker();

    // イベントリスナーの設定
    setupEventListeners();
});

/**
 * 必要なDOM要素の参照をelsオブジェクトに格納する
 */
function collectDomElements() {
    els.app = document.getElementById('app');
    els.viewMain = document.getElementById('view-main');
    els.viewHistory = document.getElementById('view-history');
    els.viewSettings = document.getElementById('view-settings');

    els.btnGenerate = document.getElementById('btn-generate');
    els.generateStatus = document.getElementById('generate-status');
    els.generateStatusSpinner = els.generateStatus.querySelector('.spinner');
    els.generateStatusText = els.generateStatus.querySelector('.message-text');
    els.btnCancelGenerate = document.getElementById('btn-cancel-generate');

    els.digestPanel = document.getElementById('digest-panel');
    els.digestMeta = document.getElementById('digest-meta');
    els.btnSpeak = document.getElementById('btn-speak');
    els.btnPause = document.getElementById('btn-pause');
    els.btnStop = document.getElementById('btn-stop');
    els.speakProgress = document.getElementById('speak-progress');
    els.digestText = document.getElementById('digest-text');

    els.historyEmpty = document.getElementById('history-empty');
    els.historyList = document.getElementById('history-list');
    els.btnClearHistory = document.getElementById('btn-clear-history');

    els.apiKey = document.getElementById('api-key');
    els.btnSaveKey = document.getElementById('btn-save-key');
    els.btnClearKey = document.getElementById('btn-clear-key');
    els.apiKeyStatus = document.getElementById('api-key-status');
    els.apiKeyStatusText = els.apiKeyStatus.querySelector('.message-text');

    els.voiceSelect = document.getElementById('voice-select');
    els.rateRange = document.getElementById('rate-range');
    els.rateValue = document.getElementById('rate-value');
    els.btnTestSpeak = document.getElementById('btn-test-speak');
    els.autoPlay = document.getElementById('auto-play');
    els.speechUnsupported = document.getElementById('speech-unsupported');

    els.modelSelect = document.getElementById('model-select');
    els.settingsStatus = document.getElementById('settings-status');

    els.bottomNav = document.querySelector('.bottom-nav');
    els.navButtons = els.bottomNav.querySelectorAll('.nav-btn');
    els.toast = document.getElementById('toast');
}

/**
 * ナビゲーションボタンのイベントリスナーを設定する
 */
function setupNavButtons() {
    els.navButtons.forEach(button => {
        button.addEventListener('click', () => {
            const viewName = button.dataset.view;
            switchView(viewName);
        });
    });
}

/**
 * 各種イベントリスナーを設定する
 */
function setupEventListeners() {
    // ダイジェスト生成
    els.btnGenerate.addEventListener('click', handleGenerateDigest);
    els.btnCancelGenerate.addEventListener('click', handleCancelGenerate);

    // 読み上げコントロール
    els.btnSpeak.addEventListener('click', () => {
        if (currentDigest) {
            startSpeaking(currentDigest.text);
        }
    });
    els.btnPause.addEventListener('click', handlePauseResume);
    els.btnStop.addEventListener('click', handleStopSpeaking);

    // 履歴
    els.historyList.addEventListener('click', handleHistoryAction);
    els.btnClearHistory.addEventListener('click', handleClearHistory);

    // 設定
    els.btnSaveKey.addEventListener('click', handleSaveApiKey);
    els.btnClearKey.addEventListener('click', handleClearApiKey);
    els.voiceSelect.addEventListener('change', handleVoiceChange);
    els.rateRange.addEventListener('input', handleRateChange);
    els.btnTestSpeak.addEventListener('click', handleTestSpeak);
    els.autoPlay.addEventListener('change', handleAutoPlayChange);
    els.modelSelect.addEventListener('change', handleModelChange);
}

/**
 * ビューを切り替える
 * @param {string} name - 切り替えるビューの名前 ('main', 'history', 'settings')
 */
function switchView(name) {
    // 全てのビューを非表示にし、activeクラスを解除
    els.viewMain.hidden = true;
    els.viewHistory.hidden = true;
    els.viewSettings.hidden = true;
    els.navButtons.forEach(btn => btn.classList.remove('active'));

    // 指定されたビューを表示し、対応するナビボタンにactiveクラスを付与
    let targetView;
    switch (name) {
        case 'main':
            targetView = els.viewMain;
            break;
        case 'history':
            targetView = els.viewHistory;
            renderHistory(); // 履歴ビューに切り替えるたびに再描画
            break;
        case 'settings':
            targetView = els.viewSettings;
            break;
        default:
            targetView = els.viewMain; // デフォルトはメイン
    }
    targetView.hidden = false;
    const navBtn = els.bottomNav.querySelector(`[data-view="${name}"]`);
    if (navBtn) navBtn.classList.add('active');
}

/**
 * 設定を読み込み、UIに反映する
 */
async function loadAndApplySettings() {
    const settings = storage.getSettings();

    // APIキー
    const apiKey = settings.geminiApiKey;
    if (apiKey) {
        els.apiKey.placeholder = '保存済み（変更する場合のみ入力）';
        els.apiKeyStatus.hidden = false;
        els.apiKeyStatus.className = 'status-message status-success';
        els.apiKeyStatusText.textContent = 'APIキーは保存済みです。';
    } else {
        els.apiKey.placeholder = 'AIza... または AQ....';
        els.apiKeyStatus.hidden = true;
    }
    els.apiKey.value = ''; // APIキーは入力欄に実値を入れない

    // 読み上げ速度
    els.rateRange.value = settings.rate;
    els.rateValue.textContent = settings.rate.toFixed(1);

    // 自動再生
    els.autoPlay.checked = settings.autoPlay;

    // Geminiモデル
    els.modelSelect.value = settings.model;
}

/**
 * Web Speech API のサポート状況をチェックし、UIを更新する
 */
function checkSpeechSupport() {
    if (!speech.isSupported()) {
        els.speechUnsupported.hidden = false;
        els.btnSpeak.disabled = true;
        els.btnTestSpeak.disabled = true;
        els.voiceSelect.disabled = true;
        els.rateRange.disabled = true;
        els.autoPlay.disabled = true;
    }
}

/**
 * 音声一覧を読み込み、#voice-select を構築する
 */
async function populateVoiceSelect() {
    const voices = await speech.loadVoices();
    const currentVoiceURI = storage.getSetting('voiceURI');

    // 既存のオプションをクリア
    els.voiceSelect.replaceChildren();

    // 「自動」オプションを追加
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = voices.length > 0 ? '自動（日本語を優先）' : '自動（この端末で利用できる音声が見つかりません）';
    els.voiceSelect.appendChild(autoOption);

    // 日本語の音声を優先してソート
    const sortedVoices = voices.sort((a, b) => {
        const isJaA = a.lang.startsWith('ja');
        const isJaB = b.lang.startsWith('ja');
        if (isJaA && !isJaB) return -1;
        if (!isJaA && isJaB) return 1;
        return a.name.localeCompare(b.name);
    });

    // 音声オプションを追加
    sortedVoices.forEach(voice => {
        const option = document.createElement('option');
        option.value = voice.voiceURI;
        option.textContent = `${voice.name}（${voice.lang}）`;
        els.voiceSelect.appendChild(option);
    });

    // 保存されている音声を選択状態にする
    if (currentVoiceURI) {
        els.voiceSelect.value = currentVoiceURI;
    } else {
        // 保存されていなければ、デフォルトの日本語音声を自動選択
        const defaultVoice = speech.pickDefaultVoice(voices, '');
        if (defaultVoice) {
            els.voiceSelect.value = defaultVoice.voiceURI;
            storage.setSetting('voiceURI', defaultVoice.voiceURI);
        }
    }
}

/**
 * 今日のダイジェストが保存されていれば読み込んで表示する
 */
async function loadTodayDigest() {
    const today = storage.getLocalDateString();
    const digests = storage.loadDigests();
    const latestDigest = digests[0];

    if (latestDigest && latestDigest.date === today) {
        currentDigest = latestDigest;
        showDigest(currentDigest);
    }
}

/**
 * APIキーを保存するハンドラ
 */
function handleSaveApiKey() {
    const key = els.apiKey.value.trim();
    if (!key) {
        els.apiKeyStatus.hidden = false;
        els.apiKeyStatus.className = 'status-message status-error';
        els.apiKeyStatusText.textContent = 'APIキーを入力してください。';
        return;
    }

    const isLooking = gemini.isApiKeyLooking(key);
    storage.setSetting('geminiApiKey', key);

    els.apiKey.value = ''; // 入力欄をクリア
    els.apiKey.placeholder = '保存済み（変更する場合のみ入力）';
    els.apiKeyStatus.hidden = false;
    els.apiKeyStatus.className = 'status-message status-success';
    els.apiKeyStatusText.textContent = 'APIキーを保存しました。';

    if (!isLooking) {
        els.apiKeyStatus.className = 'status-message status-error';
        els.apiKeyStatusText.textContent = 'キーの形式が一般的ではありません。保存しましたが、生成に失敗する場合は確認してください。';
    }
    toast('APIキーを保存しました。');
}

/**
 * APIキーをクリアするハンドラ
 */
function handleClearApiKey() {
    if (confirm('保存したAPIキーを削除しますか？')) {
        storage.clearApiKey();
        els.apiKey.value = '';
        els.apiKey.placeholder = 'AIza... または AQ....';
        els.apiKeyStatus.hidden = true;
        toast('APIキーを削除しました。');
    }
}

/**
 * 音声選択の変更ハンドラ
 */
function handleVoiceChange() {
    storage.setSetting('voiceURI', els.voiceSelect.value);
}

/**
 * 読み上げ速度の変更ハンドラ
 */
function handleRateChange() {
    const rate = Number(els.rateRange.value);
    els.rateValue.textContent = rate.toFixed(1);
    storage.setSetting('rate', rate);
}

/**
 * テスト再生ボタンのハンドラ
 */
function handleTestSpeak() {
    const settings = storage.getSettings();
    speech.speak('これはテスト再生です。この声と速さで読み上げます。', {
        voiceURI: settings.voiceURI,
        rate: settings.rate,
        onError: (err) => toast(err.message)
    });
}

/**
 * 自動再生チェックボックスの変更ハンドラ
 */
function handleAutoPlayChange() {
    storage.setSetting('autoPlay', els.autoPlay.checked);
}

/**
 * モデル選択の変更ハンドラ
 */
function handleModelChange() {
    storage.setSetting('model', els.modelSelect.value);
}

/**
 * ダイジェスト生成ボタンのハンドラ
 */
async function handleGenerateDigest() {
    const apiKey = storage.getSetting('geminiApiKey');
    if (!apiKey) {
        toast('先にGemini APIキーを設定してください。');
        switchView('settings');
        return;
    }

    speech.stop(); // 読み上げを停止

    // UIの状態を更新
    els.btnGenerate.disabled = true;
    els.btnCancelGenerate.hidden = false;
    els.generateStatus.hidden = false;
    els.generateStatus.className = 'status-message status-loading';
    els.generateStatusText.textContent = 'ニュースを生成中... (1〜3分ほどかかります)';

    generateAbortController = new AbortController();
    const signal = generateAbortController.signal;

    const settings = storage.getSettings();
    const today = storage.getLocalDateString();

    try {
        const text = await gemini.generateDigest(apiKey, {
            model: settings.model,
            today: today,
            onProgress: (stage, message) => {
                els.generateStatusText.textContent = `${message} (1〜3分ほどかかります)`;
            },
            signal: signal
        });

        const savedDigest = storage.saveDigest({ date: today, text: text });
        currentDigest = savedDigest; // 現在のダイジェストを更新
        showDigest(savedDigest);
        renderHistory();
        toast('ダイジェストを生成しました。');

        if (settings.autoPlay) {
            startSpeaking(savedDigest.text);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            toast('生成を中止しました。');
            // AbortError の場合はステータス表示をクリアしない
            els.generateStatus.hidden = true;
        } else {
            els.generateStatus.className = 'status-message status-error';
            els.generateStatusText.textContent = `生成に失敗しました: ${error.message}`;
            // エラーメッセージは表示したままにする
        }
        console.error('ダイジェスト生成エラー:', error);
    } finally {
        els.btnGenerate.disabled = false;
        els.btnCancelGenerate.hidden = true;
        generateAbortController = null;
        // AbortError 以外のエラー時はステータス表示を残すため、hidden=true はしない
        if (els.generateStatus.className.includes('status-loading')) {
            els.generateStatus.hidden = true;
        }
    }
}

/**
 * ダイジェスト生成中止ボタンのハンドラ
 */
function handleCancelGenerate() {
    if (generateAbortController) {
        generateAbortController.abort();
    }
}

/**
 * ダイジェストを表示する
 * @param {object} digest - 表示するダイジェストデータ
 */
function showDigest(digest) {
    // 別のダイジェストを開いたときに、前のダイジェストを読み上げ続けないよう止める
    speech.stop();
    els.digestPanel.hidden = false;
    els.digestMeta.textContent = `${digest.date}　約${digest.charCount}文字　読み上げ目安 約${Math.round(digest.charCount / 350)}分`;
    els.digestText.textContent = digest.text; // innerHTMLは使わない

    // 読み上げコントロールを初期状態に戻す
    resetSpeakUI();
}

/**
 * 読み上げを開始する
 * @param {string} text - 読み上げるテキスト
 */
function startSpeaking(text) {
    const settings = storage.getSettings();
    const voiceURI = settings.voiceURI;
    const rate = settings.rate;

    // UIの状態を更新
    els.btnSpeak.hidden = true;
    els.btnPause.hidden = false;
    els.btnPause.textContent = '一時停止';
    els.btnPause.dataset.state = 'playing';
    els.btnStop.hidden = false;
    els.speakProgress.hidden = false;

    const started = speech.speak(text, {
        voiceURI,
        rate,
        onChunk: (index, total) => {
            els.speakProgress.textContent = `読み上げ中 ${index + 1} / ${total}`;
        },
        onEnd: () => {
            resetSpeakUI();
            toast('読み上げが完了しました。');
        },
        onError: (err) => {
            toast(`読み上げエラー: ${err.message}`);
            resetSpeakUI();
            console.error('読み上げエラー:', err);
        }
    });

    // speak() が false（未対応 or 読み上げる文が無い）のときは
    // UIを「再生中」のまま放置しない
    if (!started) {
        resetSpeakUI();
    }
}

/**
 * 読み上げの一時停止/再開を切り替えるハンドラ
 */
function handlePauseResume() {
    if (els.btnPause.dataset.state === 'playing') {
        speech.pause();
        els.btnPause.textContent = '再開';
        els.btnPause.dataset.state = 'paused';
    } else {
        speech.resume();
        els.btnPause.textContent = '一時停止';
        els.btnPause.dataset.state = 'playing';
    }
}

/**
 * 読み上げを停止するハンドラ
 */
function handleStopSpeaking() {
    speech.stop();
    resetSpeakUI();
    toast('読み上げを停止しました。');
}

/**
 * 読み上げUIを初期状態に戻す
 */
function resetSpeakUI() {
    els.btnSpeak.hidden = false;
    els.btnPause.hidden = true;
    els.btnStop.hidden = true;
    els.speakProgress.hidden = true;
    els.btnPause.textContent = '一時停止';
    els.btnPause.dataset.state = 'playing';
}

/**
 * 履歴リストを描画する
 */
function renderHistory() {
    const digests = storage.loadDigests();

    if (digests.length === 0) {
        els.historyEmpty.hidden = false;
        els.historyList.replaceChildren(); // 子要素を全てクリア
        els.btnClearHistory.hidden = true;
        return;
    }

    els.historyEmpty.hidden = true;
    els.btnClearHistory.hidden = false;

    const fragment = document.createDocumentFragment();
    digests.forEach(d => {
        const li = document.createElement('li');
        li.className = 'history-item';

        const dateDiv = document.createElement('div');
        dateDiv.className = 'history-date';
        dateDiv.textContent = `${d.date}（約${d.charCount}文字）`;
        li.appendChild(dateDiv);

        const previewDiv = document.createElement('div');
        previewDiv.className = 'history-preview';
        previewDiv.textContent = d.text.slice(0, 60) + '…';
        li.appendChild(previewDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'history-actions';

        const openBtn = document.createElement('button');
        openBtn.className = 'secondary-btn btn-open';
        openBtn.dataset.id = d.id;
        openBtn.textContent = '開く';
        actionsDiv.appendChild(openBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'danger-btn btn-delete';
        deleteBtn.dataset.id = d.id;
        deleteBtn.textContent = '削除';
        actionsDiv.appendChild(deleteBtn);

        li.appendChild(actionsDiv);
        fragment.appendChild(li);
    });

    els.historyList.replaceChildren(fragment);
}

/**
 * 履歴リストのアクション（開く、削除）を処理するハンドラ
 * @param {Event} event - クリックイベント
 */
function handleHistoryAction(event) {
    const target = event.target;
    const openBtn = target.closest('.btn-open');
    const deleteBtn = target.closest('.btn-delete');

    if (openBtn) {
        const id = openBtn.dataset.id;
        const digest = storage.getDigestById(id);
        if (digest) {
            currentDigest = digest; // 現在のダイジェストを更新
            showDigest(digest);
            switchView('main');
        } else {
            toast('ダイジェストが見つかりませんでした。');
            renderHistory(); // 見つからない場合は履歴を再描画して整合性を保つ
        }
    } else if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (confirm('このダイジェストを削除しますか？')) {
            storage.deleteDigest(id);
            toast('ダイジェストを削除しました。');
            renderHistory();
            // もし削除したダイジェストが現在表示中のものなら、メイン画面をクリアする
            if (currentDigest && currentDigest.id === id) {
                els.digestPanel.hidden = true;
                currentDigest = null;
            }
        }
    }
}

/**
 * 履歴をすべて削除するハンドラ
 */
function handleClearHistory() {
    if (confirm('保存されているダイジェストをすべて削除しますか？')) {
        storage.clearDigests();
        toast('すべての履歴を削除しました。');
        renderHistory();
        // メイン画面に表示中のダイジェストもクリア
        els.digestPanel.hidden = true;
        currentDigest = null;
    }
}

/**
 * トーストメッセージを表示する
 * @param {string} message - 表示するメッセージ
 */
function toast(message) {
    if (toastTimeoutId) {
        clearTimeout(toastTimeoutId);
    }
    els.toast.textContent = message;
    els.toast.hidden = false;
    els.toast.classList.add('show');

    toastTimeoutId = setTimeout(() => {
        els.toast.classList.remove('show');
        // transitionend に頼ると、CSSにトランジションが無い環境でイベントが発火せず
        // トーストが消えないまま残る。タイマーで確実に隠す。
        toastTimeoutId = setTimeout(() => {
            els.toast.hidden = true;
            toastTimeoutId = null;
        }, 300);
    }, 2500);
}

/**
 * Service Worker を登録する
 */
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(registration => {
                    console.log('Service Worker registered: ', registration);
                })
                .catch(err => {
                    console.warn('Service Workerの登録に失敗しました:', err);
                });
        });
    }
}