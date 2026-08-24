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
 * 保存するダイジェストの最大数（生きているレコードのみ）。
 * @type {number}
 * @constant
 */
export const MAX_DIGESTS = 7;

/**
 * 墓標を保持する期間（ミリ秒）。30日。
 * @type {number}
 * @constant
 */
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * デフォルトの設定値。
 * @type {object}
 * @constant
 * @property {string} geminiApiKey - Gemini APIキー。
 * @property {string} voiceURI - 選択された音声のURI。
 * @property {number} rate - 読み上げ速度。
 * @property {number} volume - 読み上げ音量。
 * @property {string} model - Geminiモデル名。
 * @property {boolean} autoPlay - 自動再生の有効/無効。
 * @property {string} theme - テーマ設定 ('auto' | 'light' | 'dark')。
 */
export const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  voiceURI: '',
  rate: 1.0,
  volume: 1.0, // 変更1: volume 追加
  model: 'gemini-2.5-flash',
  autoPlay: true,
  theme: 'auto' // 変更1: theme 追加
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
 * 読み上げ音量 (volume) は 0.0 から 1.0 の範囲にクランプされます。
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

  // 変更2: volume のクランプ処理
  let volume = Number(mergedSettings.volume);
  if (isNaN(volume)) {
    volume = DEFAULT_SETTINGS.volume;
  } else {
    volume = Math.max(0.0, Math.min(1.0, volume));
  }
  mergedSettings.volume = volume;

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
    updatedAt: raw.updatedAt || createdAt, // 変更3: updatedAt 追加
    deletedAt: raw.deletedAt || '',        // 変更3: deletedAt 追加
    text: text,
    charCount: charCount
  };
}

/**
 * localStorage からダイジェストの配列を読み込み、正規化して返します。
 * 墓標（論理削除されたレコード）も含まれます。
 * @returns {Array<object>} 正規化されたダイジェストオブジェクトの配列 (createdAt 降順)。
 */
export function loadAllDigests() { // 変更3: 新設
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
 * localStorage から生きているダイジェストの配列を読み込み、新しい順 (createdAt の降順) にソートして返します。
 * 論理削除されたレコードは含まれません。
 * @returns {Array<object>} 正規化されたダイジェストオブジェクトの配列。
 */
export function loadDigests() { // 変更3: 既存の loadDigests を修正
  return loadAllDigests().filter(d => !d.deletedAt);
}

/**
 * 新しいダイジェストを保存します。
 * 同じ日付のダイジェストが既に存在する場合は、そのIDを引き継いで上書き（または復活）します。
 * 生きているレコードは最大保存数に制限し、古い墓標は削除します。
 * @param {object} digestData - 保存するダイジェストのデータ。
 * @param {string} digestData.text - ナレーション本文。
 * @param {string} [digestData.date] - 'YYYY-MM-DD' 形式の日付。省略された場合は現在日付。
 * @returns {object} 保存されたダイジェストオブジェクト。
 * @throws {Error} 保存する本文がない場合。
 */
export function saveDigest({ date, text }) { // 変更3: saveDigest を論理削除対応に修正
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('保存するダイジェストの本文がありません。');
  }

  const now = new Date().toISOString();
  const targetDate = date || getLocalDateString();

  let allDigests = loadAllDigests();
  let newDigest = {
    id: (typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).substring(2)}`),
    date: targetDate,
    createdAt: now,
    updatedAt: now,
    deletedAt: '',
    text: text,
    charCount: text.length
  };

  // 同じ日付の既存レコードを検索し、IDとcreatedAtを引き継ぐ（上書きまたは復活）
  const existingIndex = allDigests.findIndex(d => d.date === targetDate);
  if (existingIndex !== -1) {
    const existing = allDigests[existingIndex];
    newDigest.id = existing.id;
    newDigest.createdAt = existing.createdAt; // createdAt は変更しない
    allDigests.splice(existingIndex, 1); // 既存レコードを削除
  }

  allDigests.push(newDigest); // 新しい（または更新された）ダイジェストを追加

  // 正規化とソート
  allDigests = allDigests
    .map(normalizeDigest)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // 生きているレコードと墓標を分離
  const liveDigests = allDigests.filter(d => !d.deletedAt);
  const tombstoneDigests = allDigests.filter(d => d.deletedAt);

  // 生きているレコードをMAX_DIGESTSに制限
  const limitedLiveDigests = liveDigests.slice(0, MAX_DIGESTS);

  // 30日以上前の墓標を削除
  const nowTime = Date.now();
  const filteredTombstones = tombstoneDigests.filter(d =>
    !d.deletedAt || (nowTime - new Date(d.deletedAt).getTime() < TOMBSTONE_RETENTION_MS)
  );

  // 結合して保存
  const finalDigests = [...limitedLiveDigests, ...filteredTombstones]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  try {
    localStorage.setItem(DIGESTS_KEY, JSON.stringify(finalDigests));
    return newDigest;
  } catch (e) {
    console.error('ダイジェストの保存に失敗しました。ストレージ容量を確認してください。', e);
    throw new Error('ダイジェストの保存に失敗しました。');
  }
}

/**
 * 指定されたIDのダイジェストを取得します。論理削除されたレコードは返しません。
 * @param {string} id - 取得するダイジェストのID。
 * @returns {object|null} 見つかったダイジェストオブジェクト、または null。
 */
export function getDigestById(id) {
  const digests = loadDigests(); // 生きているレコードのみを返す loadDigests を使用
  return digests.find(d => d.id === id) || null;
}

/**
 * 指定されたIDのダイジェストを論理削除します。
 * @param {string} id - 削除するダイジェストのID。
 * @returns {boolean} 削除が成功した場合は true、見つからなかった場合または既に削除済みの場合は false。
 */
export function deleteDigest(id) { // 変更3: deleteDigest を論理削除対応に修正
  let allDigests = loadAllDigests();
  const index = allDigests.findIndex(d => d.id === id && !d.deletedAt); // 生きているレコードのみ対象

  if (index !== -1) {
    const now = new Date().toISOString();
    allDigests[index].deletedAt = now;
    allDigests[index].updatedAt = now;

    try {
      // 墓標のクリーンアップは saveDigest や replaceAllDigests に任せるか、別途定期実行
      localStorage.setItem(DIGESTS_KEY, JSON.stringify(allDigests));
      return true;
    } catch (e) {
      console.error('ダイジェストの論理削除に失敗しました。', e);
      return false;
    }
  }
  return false; // IDが見つからなかった場合、または既に削除済みの場合
}

/**
 * すべての生きているダイジェストを論理削除します。
 * @returns {boolean} 削除が成功した場合は true、失敗した場合は false。
 */
export function clearDigests() { // 変更3: clearDigests を論理削除対応に修正
  let allDigests = loadAllDigests();
  const now = new Date().toISOString();
  let changed = false;

  allDigests = allDigests.map(d => {
    if (!d.deletedAt) { // 生きているレコードのみに墓標を立てる
      changed = true;
      return { ...d, deletedAt: now, updatedAt: now };
    }
    return d;
  });

  if (changed) {
    try {
      // 墓標のクリーンアップは saveDigest や replaceAllDigests に任せるか、別途定期実行
      localStorage.setItem(DIGESTS_KEY, JSON.stringify(allDigests));
      return true;
    } catch (e) {
      console.error('すべてのダイジェストの論理削除に失敗しました。', e);
      return false;
    }
  }
  return false; // 変更がなかった場合
}

/**
 * 受け取ったダイジェストのリストで、ローカルの全ダイジェストを置き換えます。
 * 同期処理からの書き戻し用で、件数制限や墓標のクリーンアップは行いません。
 * @param {Array<object>} list - 新しいダイジェストの配列（墓標含む）。
 * @returns {boolean} 保存が成功した場合は true、失敗した場合は false。
 */
export function replaceAllDigests(list) { // 変更3: 新設
  if (!Array.isArray(list)) {
    console.error('replaceAllDigests には配列を渡してください。');
    return false;
  }

  // 受け取ったリストを正規化し、createdAt 降順でソート
  const normalizedList = list
    .map(normalizeDigest)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  try {
    localStorage.setItem(DIGESTS_KEY, JSON.stringify(normalizedList));
    return true;
  } catch (e) {
    console.error('全ダイジェストの置き換えに失敗しました。', e);
    return false;
  }
}
