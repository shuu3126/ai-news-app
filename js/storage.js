/**
 * @file localStorage を利用した設定とダイジェストの永続化モジュール。
 * @module storage
 */

/**
 * 設定を保存する localStorage のキー。
 * @type {string}
 * @constant
 */
export const SETTINGS_KEY = 'ainews.settings.v1';

/**
 * ダイジェストを保存する localStorage のキー。
 * @type {string}
 * @constant
 */
export const DIGESTS_KEY = 'ainews.digests.v1';

/**
 * 保存するダイジェストの最大数。
 * @type {number}
 * @constant
 */
export const MAX_DIGESTS = 7;

/**
 * デフォルトの設定値。
 * @type {object}
 * @constant
 * @property {string} geminiApiKey - Gemini APIキー。
 * @property {string} voiceURI - 選択された音声のURI。
 * @property {number} rate - 読み上げ速度。
 * @property {string} model - Geminiモデル名。
 * @property {boolean} autoPlay - 自動再生の有効/無効。
 */
export const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  voiceURI: '',
  rate: 1.0,
  model: 'gemini-2.5-flash',
  autoPlay: true
};

/**
 * ローカル時刻で 'YYYY-MM-DD' 形式の文字列を返します。
 * toISOString() はUTCで出力するため、ローカルタイムゾーンでの日付を取得するために使用します。
 * @param {Date} [date=new Date()] - 変換するDateオブジェクト。デフォルトは現在時刻。
 * @returns {string} 'YYYY-MM-DD' 形式の日付文字列。
 */
export function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * localStorage から設定を読み込み、デフォルト設定とマージして返します。
 * JSONパースに失敗した場合は、デフォルト設定のコピーを返します。
 * 読み上げ速度 (rate) は 0.5 から 2.0 の範囲にクランプされます。
 * @returns {object} 現在の設定オブジェクト。
 */
export function getSettings() {
  let storedSettings = {};
  try {
    const json = localStorage.getItem(SETTINGS_KEY);
    if (json) {
      storedSettings = JSON.parse(json);
    }
  } catch (e) {
    console.error('設定の読み込みまたはパースに失敗しました。デフォルト設定を使用します。', e);
    // パース失敗時はデフォルト設定のコピーを返す
    return { ...DEFAULT_SETTINGS };
  }

  const mergedSettings = { ...DEFAULT_SETTINGS, ...storedSettings };

  // rate のクランプ処理
  let rate = Number(mergedSettings.rate);
  if (isNaN(rate)) {
    rate = DEFAULT_SETTINGS.rate;
  } else {
    rate = Math.max(0.5, Math.min(2.0, rate));
  }
  mergedSettings.rate = rate;

  return mergedSettings;
}

/**
 * 指定されたキーの設定値を取得します。
 * @param {string} key - 取得する設定のキー。
 * @returns {*} 指定されたキーの値。キーが存在しない場合は undefined。
 */
export function getSetting(key) {
  return getSettings()[key];
}

/**
 * 指定されたキーの設定値を更新し、localStorage に保存します。
 * 保存に失敗した場合 (QuotaExceededError など) は false を返します。
 * @param {string} key - 更新する設定のキー。
 * @param {*} value - 設定する値。
 * @returns {boolean} 保存が成功した場合は true、失敗した場合は false。
 */
export function setSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    console.error('設定の保存に失敗しました。ストレージ容量を確認してください。', e);
    return false;
  }
}

/**
 * Gemini APIキーをクリアします。
 * @returns {boolean} クリアが成功した場合は true、失敗した場合は false。
 */
export function clearApiKey() {
  return setSetting('geminiApiKey', '');
}

/**
 * ダイジェストのレコード構造を正規化します。
 * 既存データに不足しているフィールドがあればデフォルト値で補完します。
 * @param {object} raw - 正規化する生のダイジェストオブジェクト。
 * @returns {object} 正規化されたダイジェストオブジェクト。
 */
function normalizeDigest(raw) {
  const now = new Date();
  const createdAt = raw.createdAt || now.toISOString();
  let date = raw.date;

  // dateがYYYY-MM-DD形式でない場合、createdAtから導出
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    try {
      date = getLocalDateString(new Date(createdAt));
    } catch (e) {
      date = getLocalDateString(now); // 導出失敗時は現在日付
    }
  }

  const text = typeof raw.text === 'string' ? raw.text : '';
  const charCount = text.length;

  return {
    // crypto.randomUUID はセキュアコンテキスト限定。LANのhttp配信では存在しないのでフォールバックする
    id: raw.id || (typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).substring(2)}`),
    date: date,
    createdAt: createdAt,
    text: text,
    charCount: charCount
  };
}

/**
 * localStorage からダイジェストの配列を読み込み、新しい順 (createdAt の降順) にソートして返します。
 * データが壊れている場合は空の配列を返します。
 * @returns {Array<object>} 正規化されたダイジェストオブジェクトの配列。
 */
export function loadDigests() {
  let digests = [];
  try {
    const json = localStorage.getItem(DIGESTS_KEY);
    if (json) {
      digests = JSON.parse(json);
      if (!Array.isArray(digests)) {
        throw new Error('保存されたダイジェストが配列ではありません。');
      }
    }
  } catch (e) {
    console.error('ダイジェストの読み込みまたはパースに失敗しました。空の配列を使用します。', e);
    return [];
  }

  // 各ダイジェストを正規化し、createdAt の降順でソート
  return digests
    .map(normalizeDigest)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * 新しいダイジェストを保存します。
 * 同じ日付のダイジェストが既に存在する場合は上書きし、最大保存数を超えた場合は古いものを削除します。
 * @param {object} digestData - 保存するダイジェストのデータ。
 * @param {string} digestData.text - ナレーション本文。
 * @param {string} [digestData.date] - 'YYYY-MM-DD' 形式の日付。省略された場合は現在日付。
 * @returns {object} 保存されたダイジェストオブジェクト。
 * @throws {Error} 保存する本文がない場合。
 */
export function saveDigest({ date, text }) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('保存するダイジェストの本文がありません。');
  }

  const newDigest = normalizeDigest({
    date: date || getLocalDateString(),
    text: text,
    createdAt: new Date().toISOString()
  });

  let digests = loadDigests();

  // 同じ日付のレコードがあれば削除 (上書きのため)
  digests = digests.filter(d => d.date !== newDigest.date);

  // 新しいダイジェストを先頭に追加
  digests.unshift(newDigest);

  // createdAt の降順でソート (念のため)
  digests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 最大保存数に制限
  digests = digests.slice(0, MAX_DIGESTS);

  try {
    localStorage.setItem(DIGESTS_KEY, JSON.stringify(digests));
    return newDigest;
  } catch (e) {
    console.error('ダイジェストの保存に失敗しました。ストレージ容量を確認してください。', e);
    throw new Error('ダイジェストの保存に失敗しました。');
  }
}

/**
 * 指定されたIDのダイジェストを取得します。
 * @param {string} id - 取得するダイジェストのID。
 * @returns {object|null} 見つかったダイジェストオブジェクト、または null。
 */
export function getDigestById(id) {
  const digests = loadDigests();
  return digests.find(d => d.id === id) || null;
}

/**
 * 指定されたIDのダイジェストを削除します。
 * @param {string} id - 削除するダイジェストのID。
 * @returns {boolean} 削除が成功した場合は true、見つからなかった場合は false。
 */
export function deleteDigest(id) {
  let digests = loadDigests();
  const initialLength = digests.length;
  digests = digests.filter(d => d.id !== id);

  if (digests.length < initialLength) {
    try {
      localStorage.setItem(DIGESTS_KEY, JSON.stringify(digests));
      return true;
    } catch (e) {
      console.error('ダイジェストの削除に失敗しました。', e);
      return false;
    }
  }
  return false; // IDが見つからなかった場合
}

/**
 * すべてのダイジェストを削除します。
 * @returns {boolean} 削除が成功した場合は true、失敗した場合は false。
 */
export function clearDigests() {
  try {
    localStorage.removeItem(DIGESTS_KEY);
    return true;
  } catch (e) {
    console.error('すべてのダイジェストの削除に失敗しました。', e);
    return false;
  }
}