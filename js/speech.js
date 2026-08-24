/**
 * @file Web Speech API (音声合成) のラッパーモジュール。
 * @module speech
 */

/**
 * 現在読み上げ中のチャンクのインデックス。
 * @type {number}
 * @private
 */
let _currentChunkIndex = 0;

/**
 * 読み上げ対象のチャンク配列。
 * @type {string[]}
 * @private
 */
let _chunks = [];

/**
 * 読み上げオプション。
 * @type {object}
 * @private
 */
let _options = {};

/**
 * 読み上げが停止されたかどうかを示すフラグ。
 * `speechSynthesis.cancel()` は `onend` を発火させるため、意図的な停止を区別するために使用。
 * @type {boolean}
 * @private
 */
let _stopped = false;

/**
 * Chromeの15秒無音バグ対策用のタイマーID。
 * @type {number|null}
 * @private
 */
let _keepAliveTimerId = null;

/**
 * 読み上げセッションの世代番号。
 * `speechSynthesis.cancel()` は、既にキューへ積んだ utterance の onend / onerror を
 * 「非同期に」発火させる。stop() 直後に speak() し直すと、
 * 古い utterance のハンドラが新しいセッションの `_stopped === false` を見てしまい、
 * 新旧のチャンクが二重に進んでしまう。
 * speak() / stop() のたびに +1 し、ハンドラ側で自分の世代と一致するときだけ動く。
 * @type {number}
 * @private
 */
let _session = 0;

/**
 * 取得済みの音声リスト（チャンクごとに loadVoices() を待つと再生が途切れるためキャッシュする）。
 * @type {SpeechSynthesisVoice[]}
 * @private
 */
let _cachedVoices = [];

/**
 * このブラウザがWeb Speech APIに対応しているかチェックします。
 * @returns {boolean} 対応している場合は true、そうでない場合は false。
 */
export function isSupported() {
  return typeof window !== 'undefined' &&
         typeof window.speechSynthesis === 'object' &&
         typeof window.SpeechSynthesisUtterance === 'function';
}

/**
 * 利用可能な音声のリストを非同期でロードします。
 * `voiceschanged` イベントを待ち、タイムアウトも設定します。
 * @returns {Promise<SpeechSynthesisVoice[]>} 利用可能な音声の配列。
 */
export function loadVoices() {
  return new Promise(resolve => {
    if (!isSupported()) {
      resolve([]);
      return;
    }

    const synth = window.speechSynthesis;
    let voices = synth.getVoices();

    if (voices.length > 0) {
      _cachedVoices = voices;
      resolve(voices);
      return;
    }

    // voiceschanged イベントを待つ
    const onVoicesChanged = () => {
      voices = synth.getVoices();
      if (voices.length > 0) {
        synth.removeEventListener('voiceschanged', onVoicesChanged);
        _cachedVoices = voices;
        resolve(voices);
      }
    };

    synth.addEventListener('voiceschanged', onVoicesChanged);

    // タイムアウトを設定 (voiceschanged イベントが来ない環境対策)
    setTimeout(() => {
      synth.removeEventListener('voiceschanged', onVoicesChanged);
      const fallback = synth.getVoices() || [];
      if (fallback.length > 0) _cachedVoices = fallback;
      resolve(fallback); // タイムアウト時にその時点の音声を返す
    }, 1500);
  });
}

/**
 * 利用可能な音声の中から、指定されたURIまたは日本語のデフォルト音声を優先して選択します。
 * @param {SpeechSynthesisVoice[]} voices - 利用可能な音声の配列。
 * @param {string} [preferredURI=''] - 優先する音声の voiceURI。
 * @returns {SpeechSynthesisVoice|null} 選択された音声オブジェクト、または null。
 */
export function pickDefaultVoice(voices, preferredURI = '') {
  if (!voices || voices.length === 0) {
    return null;
  }

  // 1. preferredURI に一致する音声
  const preferredVoice = voices.find(voice => voice.voiceURI === preferredURI);
  if (preferredVoice) {
    return preferredVoice;
  }

  // 2. 'ja-JP' かつ localService === true の音声
  const japaneseLocalVoice = voices.find(voice =>
    voice.lang.toLowerCase().replace('_', '-') === 'ja-jp' && voice.localService
  );
  if (japaneseLocalVoice) {
    return japaneseLocalVoice;
  }

  // 3. 'ja-JP' の音声
  const japaneseVoice = voices.find(voice =>
    voice.lang.toLowerCase().replace('_', '-') === 'ja-jp'
  );
  if (japaneseVoice) {
    return japaneseVoice;
  }

  // 4. 'ja' で始まる言語の最初の音声
  const anyJapaneseVoice = voices.find(voice =>
    voice.lang.toLowerCase().startsWith('ja')
  );
  if (anyJapaneseVoice) {
    return anyJapaneseVoice;
  }

  // 5. どれも見つからなければ最初の音声
  return voices[0] || null;
}

/**
 * 長文を読み上げに適したチャンクに分割します。
 * ブラウザが長文の utterance を途中で停止するのを防ぐための対策です。
 * @param {string} text - 分割するテキスト。
 * @param {number} [maxLen=120] - 各チャンクの最大文字数。
 * @returns {string[]} 分割されたテキストチャンクの配列。
 */
export function splitIntoChunks(text, maxLen = 120) {
  if (!text || text.trim() === '') {
    return [];
  }

  const paragraphs = text.split(/\n+/).filter(p => p.trim() !== '');
  const chunks = [];

  for (const paragraph of paragraphs) {
    // 句読点 (。！？!?) の直後で分割し、区切り文字は前の文に残す
    const sentences = paragraph.split(/(?<=[。！？!?])\s*/).filter(s => s.trim() !== '');

    let currentChunk = '';
    for (const sentence of sentences) {
      if (currentChunk.length + sentence.length <= maxLen) {
        // 日本語なので連結時に空白を挟まない（挟むと読み上げに不自然な間が入る）
        currentChunk += sentence;
      } else {
        // 現在のチャンクが maxLen を超える場合、または新しい文で maxLen を超える場合
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;

        // 新しい文自体が maxLen を超える場合、さらに分割
        while (currentChunk.length > maxLen) {
          let splitPoint = currentChunk.substring(0, maxLen).lastIndexOf('、');
          if (splitPoint === -1 || splitPoint < maxLen / 2) { // 読点がないか、前半すぎる場合は強制分割
            splitPoint = maxLen;
          }
          chunks.push(currentChunk.substring(0, splitPoint).trim());
          currentChunk = currentChunk.substring(splitPoint).trim();
        }
      }
    }
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
  }

  // 空文字や空白のみのチャンクを除去
  return chunks.filter(chunk => chunk !== '');
}

/**
 * 読み上げを開始します。
 * @param {string} text - 読み上げるテキスト。
 * @param {object} [options] - 読み上げオプション。
 * @param {string} [options.voiceURI] - 使用する音声の voiceURI。
 * @param {number} [options.rate=1.0] - 読み上げ速度 (0.5〜2.0)。
 * @param {number} [options.pitch=1.0] - 読み上げピッチ (0〜2)。
 * @param {number} [options.volume=1.0] - 音量 (0.0〜1.0)。
 * @param {function(number, number, string): void} [options.onChunk] - 各チャンクの再生開始時に呼ばれるコールバック (index, total, chunkText)。
 * @param {function(): void} [options.onEnd] - 全ての読み上げが終了した時に呼ばれるコールバック。
 * @param {function(Error): void} [options.onError] - エラー発生時に呼ばれるコールバック。
 * @returns {boolean} 読み上げが開始できた場合は true、そうでない場合は false。
 */
export function speak(text, options = {}) {
  if (!isSupported()) {
    if (typeof options.onError === 'function') {
      options.onError(new Error('このブラウザは音声読み上げに対応していません。'));
    }
    return false;
  }

  stop(); // 既存の読み上げを停止

  // 音声リストのキャッシュを最新化しておく（同期取得できる分だけ。
  // 空でも pickDefaultVoice が null を返し、ブラウザ既定の音声で読み上げられる）
  const currentVoices = window.speechSynthesis.getVoices();
  if (currentVoices && currentVoices.length > 0) {
    _cachedVoices = currentVoices;
  }

  _chunks = splitIntoChunks(text);
  if (_chunks.length === 0) {
    return false;
  }

  _currentChunkIndex = 0;
  _options = {
    voiceURI: options.voiceURI || '',
    rate: Math.max(0.5, Math.min(2.0, options.rate ?? 1.0)),
    pitch: Math.max(0, Math.min(2, options.pitch ?? 1.0)),
    volume: Math.max(0, Math.min(1, options.volume ?? 1.0)),
    onChunk: options.onChunk,
    onEnd: options.onEnd,
    onError: options.onError
  };
  _stopped = false;
  _session++; // stop() で積み残した古いハンドラを無効化する

  _startKeepAlive(); // Chromeのバグ対策タイマーを開始
  _startNextChunk(_session);
  return true;
}

/**
 * 次のチャンクの読み上げを開始します。
 * @param {number} session - 呼び出し時点のセッション世代番号。
 * @private
 */
function _startNextChunk(session) {
  if (session !== _session || _stopped) {
    return;
  }

  if (_currentChunkIndex >= _chunks.length) {
    _cleanupSpeech();
    if (typeof _options.onEnd === 'function') {
      _options.onEnd();
    }
    return;
  }

  const chunkIndex = _currentChunkIndex;
  const chunkText = _chunks[chunkIndex];
  const total = _chunks.length;
  const utterance = new SpeechSynthesisUtterance(chunkText);

  utterance.lang = 'ja-JP';
  utterance.rate = _options.rate;
  utterance.pitch = _options.pitch;
  utterance.volume = _options.volume;
  // 音声リストは speak() 開始前にキャッシュ済み。ここで await すると
  // チャンクの繋ぎ目に無音の隙間ができるので同期的に選ぶ。
  utterance.voice = pickDefaultVoice(_cachedVoices, _options.voiceURI);

  utterance.onstart = () => {
    if (session !== _session) return;
    if (typeof _options.onChunk === 'function') {
      _options.onChunk(chunkIndex, total, chunkText);
    }
  };

  utterance.onend = () => {
    if (session !== _session || _stopped) return;
    _currentChunkIndex++;
    _startNextChunk(session);
  };

  utterance.onerror = (event) => {
    if (session !== _session) return;
    // interrupted や canceled は意図的な停止なのでエラーとしない
    if (event.error === 'interrupted' || event.error === 'canceled') {
      _cleanupSpeech();
      return;
    }
    console.error('読み上げ中にエラーが発生しました:', event.error);
    _cleanupSpeech();
    if (typeof _options.onError === 'function') {
      _options.onError(new Error('読み上げ中にエラーが発生しました: ' + event.error));
    }
  };

  window.speechSynthesis.speak(utterance);
}

/**
 * Chromeの15秒無音バグ対策用のタイマーを開始します。
 * @private
 */
function _startKeepAlive() {
  _stopKeepAlive(); // 既存のタイマーをクリア
  if (!isSupported()) return;

  _keepAliveTimerId = setInterval(() => {
    if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    }
  }, 10000); // 10秒ごとに pause/resume
}

/**
 * Chromeの15秒無音バグ対策用のタイマーを停止します。
 * @private
 */
function _stopKeepAlive() {
  if (_keepAliveTimerId !== null) {
    clearInterval(_keepAliveTimerId);
    _keepAliveTimerId = null;
  }
}

/**
 * 読み上げ関連のリソースをクリーンアップします。
 * @private
 */
function _cleanupSpeech() {
  _stopKeepAlive();
  _stopped = true; // 確実に停止状態にする
  _chunks = [];
  _currentChunkIndex = 0;
  // window.speechSynthesis.cancel(); // speak() の開始時に stop() で呼ばれるため、ここでは不要
}

/**
 * 現在の読み上げを停止します。
 */
export function stop() {
  if (!isSupported()) return;
  _stopped = true;
  _session++; // 既にキューへ積んだ utterance のハンドラを無効化する
  _stopKeepAlive();
  window.speechSynthesis.cancel();
}

/**
 * 現在の読み上げを一時停止します。
 */
export function pause() {
  if (!isSupported()) return;
  window.speechSynthesis.pause();
}

/**
 * 一時停止中の読み上げを再開します。
 */
export function resume() {
  if (!isSupported()) return;
  window.speechSynthesis.resume();
}

/**
 * 現在読み上げ中かどうかを返します。
 * @returns {boolean} 読み上げ中であれば true、そうでなければ false。
 */
export function isSpeaking() {
  if (!isSupported()) return false;
  return window.speechSynthesis.speaking;
}

/**
 * 現在の読み上げ状態を返します。
 * @returns {object} 読み上げ状態を示すオブジェクト。
 * @property {boolean} speaking - 読み上げ中かどうか。
 * @property {boolean} paused - 一時停止中かどうか。
 * @property {number} index - 現在読み上げているチャンクのインデックス。
 * @property {number} total - 全チャンク数。
 */
export function getState() {
  if (!isSupported()) {
    return { speaking: false, paused: false, index: 0, total: 0 };
  }
  return {
    speaking: window.speechSynthesis.speaking,
    paused: window.speechSynthesis.paused,
    index: _currentChunkIndex,
    total: _chunks.length
  };
}