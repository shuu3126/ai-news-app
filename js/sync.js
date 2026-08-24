/**
 * @file sync.js
 * @brief 端末をまたいだ自動同期（Googleドライブ）のマージ処理と実行制御。
 *
 * 方針:
 * - 同期は「取ってきて → 混ぜて → 書き戻して → 上げ直す」の1本道にする。
 *   アップロードだけの片道同期だと、スマホで入れた分がPCに来ないし、
 *   逆にPCから上書きしてスマホの入力を消してしまう。
 * - マージはレコード単位の Last-Write-Wins（id をキー、`updatedAt` が新しい方を採用）。
 *   時刻の比較は文字列ではなく `Date.parse()` で行う。
 *   保存形式が `...Z`（UTC）と `...+09:00`（ローカル）で混在しているため、
 *   文字列比較すると 09:00+09:00 < 00:00Z のような誤判定が起きる。
 * - 削除は「削除フラグを立てる更新」として扱う（storage.js は論理削除）。
 *   物理削除のままだと、古いコピーを持つ端末が同期した瞬間に削除が取り消されてしまう。
 * - 同じレコードの時刻が完全に同着だったときは「削除」を優先する。
 *   復活してしまうより、消えている方が気づきやすく被害が小さいため。
 */

import {
    loadAllDigests,
    replaceAllDigests
} from './storage.js';

/** ペイロードの構造バージョン。1 = digests のみ */
export const PAYLOAD_SCHEMA_VERSION = 1;

/** マージ対象のコレクション名（ペイロード内のキー） */
const COLLECTIONS = ['digests'];

/**
 * ISO8601文字列をミリ秒に変換します。解釈できなければ 0。
 * @param {any} value
 * @returns {number}
 */
export function toTime(value) {
    if (typeof value !== 'string' || value === '') return 0;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
}

/**
 * そのレコードが「最後に動いた」時刻を返します（削除も更新の一種として扱う）。
 * @param {object} record
 * @returns {number}
 */
function recordTime(record) {
    if (!record) return 0;
    return Math.max(toTime(record.updatedAt), toTime(record.deletedAt), toTime(record.createdAt));
}

/**
 * 同じIDの2つのレコードから、採用する方を選びます。
 * @param {object} mine - ローカル側
 * @param {object} theirs - リモート側
 * @returns {object} 採用するレコード
 */
function pickNewer(mine, theirs) {
    const mineTime = recordTime(mine);
    const theirsTime = recordTime(theirs);

    if (theirsTime > mineTime) return theirs;
    if (mineTime > theirsTime) return mine;

    // 完全に同着のときは削除を優先（消えたものが復活するより安全）
    if (theirs.deletedAt && !mine.deletedAt) return theirs;
    return mine;
}

/**
 * 2つのレコードが実質同じかどうか（アップロードが必要か判定するため）。
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isSameRecord(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * id をキーに、2つのレコード配列をマージします。
 * @param {Array<object>} localList
 * @param {Array<object>} remoteList
 * @returns {{merged: Array<object>, fromRemote: number, toRemote: number}}
 *   fromRemote: リモート由来で取り込んだ件数（ローカルを書き換える必要がある件数）
 *   toRemote:   リモートに無い／古い件数（アップロードし直す必要がある件数）
 */
export function mergeRecords(localList, remoteList) {
    const locals = Array.isArray(localList) ? localList : [];
    const remotes = Array.isArray(remoteList) ? remoteList : [];

    const merged = new Map();
    for (const record of locals) {
        if (record && typeof record.id === 'string' && record.id) merged.set(record.id, record);
    }

    const remoteMap = new Map();
    let fromRemote = 0;

    for (const record of remotes) {
        if (!record || typeof record.id !== 'string' || !record.id) continue;
        remoteMap.set(record.id, record);

        const mine = merged.get(record.id);
        if (!mine) {
            merged.set(record.id, record);
            fromRemote++;
            continue;
        }
        const winner = pickNewer(mine, record);
        if (winner !== mine && !isSameRecord(mine, record)) {
            merged.set(record.id, record);
            fromRemote++;
        }
    }

    // マージ結果とリモートを比べ、リモート側が遅れている件数を数える
    let toRemote = 0;
    for (const [id, record] of merged) {
        const theirs = remoteMap.get(id);
        if (!theirs || !isSameRecord(record, theirs)) toRemote++;
    }

    return { merged: [...merged.values()], fromRemote, toRemote };
}

/**
 * 受け取ったペイロードから、マージに必要な形だけを取り出します。
 * 旧バージョン（素の配列）でも壊れないようにします。
 * @param {object|Array} payload
 * @returns {{digests:Array}}
 */
export function normalizePayloadShape(payload) {
    if (Array.isArray(payload)) {
        // 一番古い形式（Digestの生配列）
        return { digests: payload };
    }
    const source = (payload && typeof payload === 'object') ? payload : {};
    return {
        digests: Array.isArray(source.digests) ? source.digests : []
    };
}

/**
 * ローカルとリモートのペイロードをマージします。
 * @param {object|Array} localPayload
 * @param {object|Array} remotePayload
 * @returns {{merged: object, stats: object}}
 */
export function mergePayloads(localPayload, remotePayload) {
    const local = normalizePayloadShape(localPayload);
    const remote = normalizePayloadShape(remotePayload);

    const merged = {};
    const stats = { localChanged: false, remoteChanged: false, collections: {} };

    for (const key of COLLECTIONS) {
        const result = mergeRecords(local[key], remote[key]);
        merged[key] = result.merged;
        stats.collections[key] = { fromRemote: result.fromRemote, toRemote: result.toRemote };
        if (result.fromRemote > 0) stats.localChanged = true;
        if (result.toRemote > 0) stats.remoteChanged = true;
    }

    return { merged, stats };
}

/**
 * いまローカルに入っているデータを、同期用のペイロードとして組み立てます。
 * 削除済み（tombstone）も必ず含めます。含めないと削除が他の端末へ伝わりません。
 * @returns {object}
 */
export function buildSyncPayload() {
    const allDigests = loadAllDigests();
    return {
        app: 'ai-news-app',
        schemaVersion: PAYLOAD_SCHEMA_VERSION,
        scope: 'personal-ai-news-digests-only',
        exportedAt: _localISOString(),
        count: allDigests.length,
        digests: allDigests
    };
}

/**
 * マージ結果をローカルへ書き戻します。
 * @param {object} payload - mergePayloads() の merged
 * @returns {void}
 */
export function applyPayload(payload) {
    const data = normalizePayloadShape(payload);
    replaceAllDigests(data.digests);
}

/**
 * ローカル時刻のオフセット付きISO文字列。
 * @returns {string}
 */
function _localISOString() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const offset = now.getTimezoneOffset();
    const sign = offset > 0 ? '-' : '+';
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
        + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/**
 * @typedef {object} SyncDeps
 * @property {() => {configured:boolean, signedIn:boolean}} getStatus - ドライブ連携の状態
 * @property {() => Promise<object|null>} download - ドライブからペイロードを取得
 * @property {(payload:object) => Promise<any>} upload - ドライブへペイロードを保存
 * @property {() => boolean} [isOnline] - オンライン判定（既定 navigator.onLine）
 * @property {(stats:object) => void} [onApplied] - ローカルを書き換えたときに呼ばれる
 * @property {(error:Error, context:string) => void} [onError]
 * @property {number} [intervalMs] - 定期同期の間隔（既定60秒）
 */

/**
 * 自動同期を初期化します。
 * @param {SyncDeps} deps
 * @returns {{sync: (options?: object) => Promise<object>, start: () => void, stop: () => void, isRunning: () => boolean}}
 */
export function initSync(deps) {
    const isOnline = deps.isOnline || (() => navigator.onLine);
    const intervalMs = deps.intervalMs || 60000;

    let running = false;   // 多重実行の防止（同時に走ると取り違えて上書きし合う）
    let timerId = null;
    let started = false;

    /**
     * 1回ぶんの同期（取得 → マージ → 書き戻し → 送信）。
     * @param {{force?: boolean}} [options]
     * @returns {Promise<{status:string, stats?:object, reason?:string}>}
     */
    async function sync(options = {}) {
        if (running) return { status: 'skipped', reason: 'busy' };

        const st = deps.getStatus();
        if (!st.configured) return { status: 'skipped', reason: 'not-configured' };
        if (!st.signedIn) return { status: 'skipped', reason: 'not-signed-in' };
        if (!isOnline()) return { status: 'skipped', reason: 'offline' };

        running = true;
        try {
            // ローカルの読み取りは必ず download() の後で行う。
            // download()はネットワーク待ちが発生する非同期処理なので、
            // 先にローカルを読んでしまうと「待っている間にユーザーが保存した新しいダイジェスト」を
            // 拾えないまま merged で上書き（=保存した記録が消える）ことがある。
            // download の後なら、あとは同期処理（buildSyncPayload→merge→applyPayload）で
            // await を挟まないため、この間に保存されたデータを取りこぼす窓はほぼ無くなる。
            const remote = await deps.download();
            const local = buildSyncPayload();

            // ドライブにまだ何も無い（初回）
            if (!remote) {
                await deps.upload(local);
                return { status: 'uploaded', reason: 'no-remote' };
            }

            const { merged, stats } = mergePayloads(local, remote);

            if (stats.localChanged) {
                applyPayload(merged);
                if (deps.onApplied) deps.onApplied(stats);
            }

            // マージ結果をドライブへ返す。
            // ここを省くと、2台目が入れた分がドライブに載らないまま次の上書きで消える。
            if (stats.localChanged || stats.remoteChanged || options.force) {
                await deps.upload(buildSyncPayload());
            }

            return { status: 'merged', stats };
        } catch (error) {
            if (deps.onError) deps.onError(error, 'sync');
            return { status: 'error', reason: error.message };
        } finally {
            running = false;
        }
    }

    /** 画面が見えている間だけ定期同期する（バックグラウンドで叩き続けない） */
    function handleVisibility() {
        if (document.visibilityState === 'visible') sync();
    }

    function handleOnline() {
        sync();
    }

    function start() {
        if (started) return;
        started = true;
        document.addEventListener('visibilitychange', handleVisibility);
        window.addEventListener('online', handleOnline);
        timerId = setInterval(() => {
            if (document.visibilityState === 'visible') sync();
        }, intervalMs);
    }

    function stop() {
        if (!started) return;
        started = false;
        document.removeEventListener('visibilitychange', handleVisibility);
        window.removeEventListener('online', handleOnline);
        if (timerId) clearInterval(timerId);
        timerId = null;
    }

    return { sync, start, stop, isRunning: () => running };
}
