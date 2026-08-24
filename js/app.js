import * as storage from './storage.js';
import * as gemini from './gemini.js';
import * as speech from './speech.js';
import { initSync } from './sync.js';
import {
    FOLDER_NAME,
    DATA_FILENAME as DRIVE_FILENAME,
    loadGis,
    signIn as driveSignIn,
    signOut as driveSignOut,
    uploadData,
    downloadData,
    getStatus as driveGetStatus,
    clearDriveRefs
} from './drivesync.js';

/**
 * アプリケーションの表示テーマを適用する
 * @param {string} theme - 'auto', 'light', 'dark' のいずれか
 */
function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
        document.body.dataset.theme = theme;
    } else {
        // 'auto' の場合は属性を削除し、OSのテーマ設定に合わせる
        delete document.body.dataset.theme;
    }
}
// DOMContentLoaded より前にテーマを適用し、一瞬のチラつきを防ぐ
applyTheme(storage.getSetting('theme'));

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
 * 同期コントローラ
 * @type {object}
 */
const syncController = initSync({
    getStatus: () => driveGetStatus(),
    download: () => downloadData(),
    upload: (payload) => uploadData(payload),
    onApplied: () => { renderHistory(); refreshCurrentDigest(); },
    onError: (error, context) => console.error(`同期エラー(${context}):`, error)
});

/**
 * 現在表示中のダイジェストが同期によって変更された場合に表示を更新する
 */
function refreshCurrentDigest() {
    if (!currentDigest) {
        return;
    }

    // 読み上げ中は中断しない
    if (speech.isSpeaking()) {
        return;
    }

    const updatedDigest = storage.getDigestById(currentDigest.id);

    if (!updatedDigest) {
        // 他端末で削除された場合
        els.digestPanel.hidden = true;
        currentDigest = null;
        updateMainEmpty();
        toast('表示中のダイジェストが他端末で削除されました。');
        return;
    }

    // 中身が変わっているかチェック (簡易的にテキストと文字数で)
    if (updatedDigest.text !== currentDigest.text || updatedDigest.charCount !== currentDigest.charCount) {
        currentDigest = updatedDigest; // 更新されたダイジェストに差し替え
        showDigest(currentDigest); // UIを再描画
        toast('表示中のダイジェストが他端末で更新されました。');
    }
    // 変わっていなければ何もしない
}

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

    // 9. Googleドライブ同期の初期化
    updateDriveStatus(); // まずは現在の状態を表示

    const googleClientId = storage.getSetting('googleClientId');
    if (googleClientId) {
        els.googleClientId.placeholder = '保存済み（変更する場合のみ入力）';
        // GISの読み込みと無音サインインはawaitでブロックしない
        loadGis().then(() => {
            return driveSignIn(googleClientId, false); // silent = true ではないが、UIは出さない
        }).then(isSignedIn => {
            if (isSignedIn) {
                console.log('Googleドライブに無音サインインしました。');
                syncController.start(); // 同期コントローラを起動
                updateDriveStatus(); // ログイン状態を更新
                syncNow(true); // 初回同期を静かに実行
            } else {
                console.warn('Googleドライブへの無音サインインに失敗しました。');
                updateDriveStatus(); // 失敗状態を更新
            }
        }).catch(error => {
            console.error('Googleドライブ初期化エラー:', error);
            updateDriveStatus(); // エラー状態を更新
        });
    }

    // 10. イベントリスナーの設定
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
    els.mainEmpty = document.getElementById('main-empty'); // 新規

    els.digestPanel = document.getElementById('digest-panel');
    els.digestMeta = document.getElementById('digest-meta');
    els.btnSpeak = document.getElementById('btn-speak');
    els.btnPause = document.getElementById('btn-pause');
    els.btnStop = document.getElementById('btn-stop');
    els.speakProgress = document.getElementById('speak-progress');
    els.speakEqualizer = document.getElementById('speak-equalizer'); // 新規
    els.digestText = document.getElementById('digest-text');

    els.recentRail = document.getElementById('recent-rail'); // 新規
    els.recentRailList = document.getElementById('recent-rail-list'); // 新規
    els.recentRailEmpty = document.getElementById('recent-rail-empty'); // 新規

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
    els.volumeRange = document.getElementById('volume-range'); // 新規
    els.volumeValue = document.getElementById('volume-value'); // 新規
    els.btnTestSpeak = document.getElementById('btn-test-speak');
    els.autoPlay = document.getElementById('auto-play');
    els.speechUnsupported = document.getElementById('speech-unsupported');

    els.themeSelect = document.getElementById('theme-select'); // 新規

    els.modelSelect = document.getElementById('model-select');
    els.settingsStatus = document.getElementById('settings-status');

    els.googleClientId = document.getElementById('google-client-id'); // 新規
    els.btnSaveClientId = document.getElementById('btn-save-client-id'); // 新規
    els.driveStatus = document.getElementById('drive-status'); // 新規
    els.btnDriveSignin = document.getElementById('btn-drive-signin'); // 新規
    els.btnSyncNow = document.getElementById('btn-sync-now'); // 新規
    els.btnDriveSignout = document.getElementById('btn-drive-signout'); // 新規

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

    // 最近のダイジェスト（右レール）
    els.recentRailList.addEventListener('click', handleRecentRailClick);

    // 設定
    els.btnSaveKey.addEventListener('click', handleSaveApiKey);
    els.btnClearKey.addEventListener('click', handleClearApiKey);
    els.voiceSelect.addEventListener('change', handleVoiceChange);
    els.rateRange.addEventListener('input', handleRateChange);
    els.volumeRange.addEventListener('input', handleVolumeChange); // 新規
    els.btnTestSpeak.addEventListener('click', handleTestSpeak);
    els.autoPlay.addEventListener('change', handleAutoPlayChange);
    els.themeSelect.addEventListener('change', handleThemeChange); // 新規
    els.modelSelect.addEventListener('change', handleModelChange);

    // Googleドライブ同期
    els.btnSaveClientId.addEventListener('click', handleSaveClientId); // 新規
    els.btnDriveSignin.addEventListener('click', handleDriveSignIn); // 新規
    els.btnSyncNow.addEventListener('click', () => syncNow(false)); // 新規
    els.btnDriveSignout.addEventListener('click', handleDriveSignOut); // 新規
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

    // 読み上げ音量
    els.volumeRange.value = settings.volume; // 新規
    els.volumeValue.textContent = Math.round(settings.volume * 100) + '%'; // 新規

    // 自動再生
    els.autoPlay.checked = settings.autoPlay;

    // 表示テーマ
    els.themeSelect.value = settings.theme; // 新規

    // Geminiモデル
    els.modelSelect.value = settings.model;

    // GoogleクライアントID
    const googleClientId = settings.googleClientId;
    if (googleClientId) {
        els.googleClientId.placeholder = '保存済み（変更する場合のみ入力）';
    } else {
        els.googleClientId.placeholder = 'xxxxx.apps.googleusercontent.com';
    }
    els.googleClientId.value = ''; // クライアントIDも入力欄に実値を入れない
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
        els.volumeRange.disabled = true; // 新規
        els.autoPlay.disabled = true;
    }
}

/**
 * 音声の表示名を整形する
 * @param {SpeechSynthesisVoice} voice - 音声オブジェクト
 * @returns {string} 整形された音声名
 */
function formatVoiceName(voice) {
    let name = voice.name;
    const langMap = {
        'ja': '日本語', 'en': '英語', 'zh': '中国語', 'ko': '韓国語', 'fr': 'フランス語',
        'de': 'ドイツ語', 'es': 'スペイン語', 'it': 'イタリア語', 'pt': 'ポルトガル語', 'ru': 'ロシア語'
    };
    const langDisplayName = langMap[voice.lang.split('-')[0]] || voice.lang;

    // ベンダー接頭辞を削除
    const vendors = ['Microsoft ', 'Google ', 'Apple '];
    for (const vendor of vendors) {
        if (name.startsWith(vendor)) {
            name = name.substring(vendor.length);
            break;
        }
    }

    // 言語表記を削除 (例: " - Japanese (Japan)", "(ja-JP)")
    name = name.replace(/ - [A-Za-z\s]+\s*(\([A-Za-z-]+\))?$/, '');
    name = name.replace(/\s*\([a-z]{2}-[A-Z]{2}\)$/, '');

    // 短縮した結果が空になる場合は元の名前を使う
    if (name.trim() === '') {
        name = voice.name;
    }

    return `${name}（${langDisplayName}）`;
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
        option.textContent = formatVoiceName(voice); // 整形した名前を使用
        option.title = `${voice.name}（${voice.lang}）`; // デバッグ用に元の名前とロケールをtitleに
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
    updateMainEmpty(); // メイン画面の空状態を更新
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
 * 読み上げ音量の変更ハンドラ
 */
function handleVolumeChange() {
    const volume = Number(els.volumeRange.value);
    els.volumeValue.textContent = Math.round(volume * 100) + '%';
    storage.setSetting('volume', volume);
}

/**
 * テスト再生ボタンのハンドラ
 */
function handleTestSpeak() {
    const settings = storage.getSettings();
    speech.speak('これはテスト再生です。この声と速さで読み上げます。', {
        voiceURI: settings.voiceURI,
        rate: settings.rate,
        volume: settings.volume, // 新規
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
 * テーマ選択の変更ハンドラ
 */
function handleThemeChange() {
    const theme = els.themeSelect.value;
    storage.setSetting('theme', theme);
    applyTheme(theme);
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
    els.btnGenerate.classList.add('is-generating'); // シマー開始
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
        autoSync(); // 生成成功後に同期
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
        els.btnGenerate.classList.remove('is-generating'); // シマー終了
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
 * メインビューの空状態表示を更新する
 */
function updateMainEmpty() {
    els.mainEmpty.hidden = !els.digestPanel.hidden;
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
    updateMainEmpty(); // メイン画面の空状態を更新
    renderRecentRail(); // 現在表示中のダイジェストをハイライトするため
}

/**
 * 読み上げを開始する
 * @param {string} text - 読み上げるテキスト
 */
function startSpeaking(text) {
    const settings = storage.getSettings();
    const voiceURI = settings.voiceURI;
    const rate = settings.rate;
    const volume = settings.volume; // 新規

    // UIの状態を更新
    els.btnSpeak.hidden = true;
    els.btnPause.hidden = false;
    els.btnPause.textContent = '一時停止';
    els.btnPause.dataset.state = 'playing';
    els.btnStop.hidden = false;
    els.speakProgress.hidden = false;
    els.speakEqualizer.hidden = false; // イコライザー表示
    els.speakEqualizer.classList.remove('is-paused'); // 一時停止状態を解除

    const started = speech.speak(text, {
        voiceURI,
        rate,
        volume, // 新規
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
        els.speakEqualizer.classList.add('is-paused'); // イコライザー一時停止
    } else {
        speech.resume();
        els.btnPause.textContent = '一時停止';
        els.btnPause.dataset.state = 'playing';
        els.speakEqualizer.classList.remove('is-paused'); // イコライザー再開
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
    els.speakEqualizer.hidden = true; // イコライザー非表示
    els.speakEqualizer.classList.remove('is-paused'); // 一時停止状態を解除
    els.btnPause.textContent = '一時停止';
    els.btnPause.dataset.state = 'playing';
}

/**
 * 日付文字列を相対的な表現にフォーマットする
 * @param {string} dateString - YYYY-MM-DD形式の日付文字列
 * @param {string} [todayString=storage.getLocalDateString()] - 今日の日付文字列 (YYYY-MM-DD)
 * @returns {string} 相対的な日付表現 ('今日', '昨日', 'N日前' など)
 */
function formatRelativeDate(dateString, todayString = storage.getLocalDateString()) {
    const parseDate = (dStr) => {
        const [year, month, day] = dStr.split('-').map(Number);
        return new Date(year, month - 1, day); // UTC解釈を避けるためローカルタイムで
    };

    const date = parseDate(dateString);
    const today = parseDate(todayString);

    const diffTime = today.getTime() - date.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)); // 日数差を計算

    if (diffDays === 0) {
        return '今日';
    } else if (diffDays === 1) {
        return '昨日';
    } else if (diffDays === 2) {
        return '一昨日';
    } else if (diffDays >= 3 && diffDays <= 6) {
        return `${diffDays}日前`;
    } else {
        return dateString; // それ以外は元のYYYY-MM-DD形式
    }
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
    } else {
        els.historyEmpty.hidden = true;
        els.btnClearHistory.hidden = false;

        const fragment = document.createDocumentFragment();
        digests.forEach(d => {
            const li = document.createElement('li');
            li.className = 'history-item';

            const dateDiv = document.createElement('div');
            dateDiv.className = 'history-date';
            dateDiv.textContent = `${formatRelativeDate(d.date)}（${d.date}・約${d.charCount}文字）`; // 相対日付を適用
            li.appendChild(dateDiv);

            const previewDiv = document.createElement('div');
            previewDiv.className = 'history-preview';
            previewDiv.textContent = d.text.slice(0, 60) + '…';
            li.appendChild(previewDiv);

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'history-actions';

            const openBtn = document.createElement('button');
            openBtn.className = 'primary-btn btn-open'; // primary-btn に変更
            openBtn.dataset.id = d.id;
            openBtn.textContent = '開く';
            actionsDiv.appendChild(openBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'ghost-btn btn-delete'; // ghost-btn に変更
            deleteBtn.dataset.id = d.id;
            deleteBtn.textContent = '削除';
            actionsDiv.appendChild(deleteBtn);

            li.appendChild(actionsDiv);
            fragment.appendChild(li);
        });

        els.historyList.replaceChildren(fragment);
    }
    renderRecentRail(); // 履歴更新時に右レールも更新
}

/**
 * 右レール「最近のダイジェスト」を描画する
 */
function renderRecentRail() {
    const digests = storage.loadDigests().slice(0, 5); // 最新5件

    if (digests.length === 0) {
        els.recentRailEmpty.hidden = false;
        els.recentRailList.replaceChildren();
        return;
    }

    els.recentRailEmpty.hidden = true;
    const fragment = document.createDocumentFragment();

    digests.forEach(d => {
        const li = document.createElement('li');
        li.className = 'rail-item';

        const button = document.createElement('button');
        button.className = 'rail-item-btn';
        if (currentDigest && currentDigest.id === d.id) {
            button.classList.add('is-current');
        }
        button.dataset.id = d.id;

        const dateSpan = document.createElement('span');
        dateSpan.className = 'rail-date';
        dateSpan.textContent = formatRelativeDate(d.date);
        button.appendChild(dateSpan);

        const previewSpan = document.createElement('span');
        previewSpan.className = 'rail-preview';
        previewSpan.textContent = d.text.slice(0, 50);
        button.appendChild(previewSpan);

        li.appendChild(button);
        fragment.appendChild(li);
    });

    els.recentRailList.replaceChildren(fragment);
}

/**
 * 右レール「最近のダイジェスト」のクリックハンドラ
 * @param {Event} event - クリックイベント
 */
function handleRecentRailClick(event) {
    const target = event.target.closest('.rail-item-btn');
    if (target) {
        const id = target.dataset.id;
        const digest = storage.getDigestById(id);
        if (digest) {
            currentDigest = digest;
            showDigest(digest);
            // switchView('main'); // すでにメインビューにいるので不要
        } else {
            toast('ダイジェストが見つかりませんでした。');
            renderHistory(); // 見つからない場合は履歴を再描画して整合性を保つ
        }
    }
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
                updateMainEmpty(); // メイン画面の空状態を更新
            }
            autoSync(); // 削除後に同期
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
        updateMainEmpty(); // メイン画面の空状態を更新
        autoSync(); // 削除後に同期
    }
}

/**
 * Googleドライブ同期のUI状態を更新する
 */
async function updateDriveStatus() {
    const status = await driveGetStatus();
    const googleClientId = storage.getSetting('googleClientId');

    // まず全てのボタンを隠す
    els.btnDriveSignin.hidden = true;
    els.btnSyncNow.hidden = true;
    els.btnDriveSignout.hidden = true;
    els.driveStatus.className = 'status-message'; // デフォルトのスタイルに戻す

    if (!googleClientId) {
        els.driveStatus.textContent = '未設定 — GoogleクライアントIDを登録してください';
        return;
    }

    if (!status.signedIn) {
        els.driveStatus.textContent = '未ログイン —「Googleでログイン」を押してください';
        els.btnDriveSignin.hidden = false;
        return;
    }

    let lastSyncedAtText = '未同期';
    if (status.lastSyncedAt) {
        const date = new Date(status.lastSyncedAt);
        lastSyncedAtText = `最終同期: ${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    }

    els.driveStatus.textContent = `ログイン中 / ${FOLDER_NAME}/${DRIVE_FILENAME} — ${lastSyncedAtText}`;
    els.driveStatus.classList.add('status-success');
    els.btnSyncNow.hidden = false;
    els.btnDriveSignout.hidden = false;
}

/**
 * GoogleクライアントIDを保存するハンドラ
 */
async function handleSaveClientId() {
    const id = els.googleClientId.value.trim();
    if (!id) {
        toast('GoogleクライアントIDを入力してください。');
        return;
    }
    if (!id.endsWith('.apps.googleusercontent.com')) {
        toast('クライアントIDの形式が一般的ではありません（.apps.googleusercontent.comで終わるはずです）。保存はしますが、確認してください。');
    }

    storage.setSetting('googleClientId', id);
    els.googleClientId.value = '';
    els.googleClientId.placeholder = '保存済み（変更する場合のみ入力）';
    toast('GoogleクライアントIDを保存しました。');
    await updateDriveStatus();
}

/**
 * Googleドライブにサインインするハンドラ
 */
async function handleDriveSignIn() {
    const clientId = storage.getSetting('googleClientId');
    if (!clientId) {
        toast('先にGoogleクライアントIDを設定してください。');
        switchView('settings');
        return;
    }

    try {
        await loadGis(); // GISライブラリをロード
        const isSignedIn = await driveSignIn(clientId, true); // UIを伴うサインイン
        if (isSignedIn) {
            toast('Googleにログインしました。');
            syncController.start(); // 同期コントローラを起動
            await syncNow(false); // 初回同期を実行
        } else {
            toast('ログインできませんでした。クライアントIDと承認済みJavaScript生成元を確認してください。');
        }
    } catch (error) {
        console.error('Googleドライブサインインエラー:', error);
        toast(`ログインに失敗しました: ${error.message}`);
    } finally {
        await updateDriveStatus();
    }
}

/**
 * Googleドライブからサインアウトするハンドラ
 */
async function handleDriveSignOut() {
    if (confirm('Googleドライブとの連携を解除しますか？（この端末の履歴は消えません）')) {
        try {
            syncController.stop(); // 同期コントローラを停止
            await driveSignOut();
            toast('ログアウトしました。');
        } catch (error) {
            console.error('Googleドライブサインアウトエラー:', error);
            toast(`ログアウトに失敗しました: ${error.message}`);
        } finally {
            await updateDriveStatus();
            // clearDriveRefs(); // フォルダID/ファイルIDを消すと再ログイン時に探し直しになるため呼ばない
        }
    }
}

/**
 * Googleドライブと今すぐ同期する
 * @param {boolean} silent - エラーや成功メッセージをトースト表示しないか
 */
async function syncNow(silent = false) {
    const clientId = storage.getSetting('googleClientId');
    const driveStatus = await driveGetStatus();

    if (!clientId || !driveStatus.signedIn || !navigator.onLine) {
        if (!silent) {
            if (!clientId) toast('GoogleクライアントIDが設定されていません。');
            else if (!driveStatus.signedIn) toast('Googleドライブにログインしていません。');
            else if (!navigator.onLine) toast('オフラインのため同期できません。');
        }
        return;
    }

    try {
        const result = await syncController.sync({ force: !silent });
        await updateDriveStatus(); // 同期結果をUIに反映

        if (result.status === 'error') {
            if (!silent) toast('同期に失敗しました: ' + result.reason);
        } else if (!silent && (result.status === 'merged' || result.status === 'uploaded')) {
            toast('Googleドライブと同期しました。');
        }
        // 成功時は renderHistory() が onApplied で呼ばれる
    } catch (error) {
        console.error('syncNowエラー:', error);
        if (!silent) toast('同期中に予期せぬエラーが発生しました。');
        await updateDriveStatus();
    }
}

/**
 * 自動同期を実行する（エラーは握りつぶす）
 */
function autoSync() {
    syncNow(true).catch(() => {}); // エラーはコンソールに出るが、UIには表示しない
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
