/**
 * ai-news-app Google Drive同期モジュール
 *
 * このモジュールは、Google Identity Services (GIS) を使用してOAuth2.0認証を行い、
 * Google Drive APIを通じてダイジェストデータを読み書きします。
 *
 * 絶対制約:
 * - 素のJavaScript（ES Module）。npm・バンドラ・外部ライブラリ禁止。
 * - 唯一の外部読み込みは Google Identity Services のスクリプト
 *   `https://accounts.google.com/gsi/client` のみ（動的に `<script>` を挿入して読み込む）。
 * - OAuthスコープは `https://www.googleapis.com/auth/drive.file` だけ。
 * - アクセストークンはメモリ上の変数にのみ保持する。
 * - localStorage に保存してよいのは `clientId` `folderId` `fileId` `最終同期日時` だけ。
 * - ダイジェストデータはGoogle Drive以外の第三者に送信しない。
 *
 * drive.file スコープの制約:
 * `drive.file` ではアプリ自身が作成したファイル／フォルダにしかアクセスできません。
 * ユーザーが手で作った既存フォルダ（例: マイドライブ内の `2.副業`）は
 * 検索にも出てこないし、その中に書き込むこともできません。
 *
 * したがって、アプリはマイドライブ直下に自分専用のフォルダを新規作成します。
 * フォルダ名は `ai-news-app-data` です。
 * 一度作ったら `folderId` と `fileId` を localStorage に記憶し、
 * 以降は必ずIDで直接アクセスします（名前で探し直さない）。
 * IDでアクセスする設計にしておくと、ユーザーがGoogleドライブの画面で
 * そのフォルダを別の場所（例: `2.副業/ai-news-app/` の下）へ移動しても、
 * アプリは変わらず読み書きできます。
 */

// --- 公開定数 ---
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const FOLDER_NAME = 'ai-news-app-data'; // 変更: ai-news-app-data
export const DATA_FILENAME = 'ai-news-data.json'; // 変更: ai-news-data.json

// --- 内部状態変数 ---
let _accessToken = null;
let _tokenExpiresAt = 0; // ミリ秒のタイムスタンプ
let _tokenClient = null;
let _tokenClientId = null; // _tokenClient を作ったときのクライアントID
let _gisLoaded = false;
let _email = null; // サインインしたユーザーのメールアドレス

// localStorageのキー
const LOCAL_STORAGE_KEY = 'ainews.settings.v1'; // 変更: ainews.settings.v1

// --- localStorageヘルパー ---

/**
 * localStorageから設定を読み込む。
 * @param {string} key - 取得する設定のキー
 * @returns {any} 設定値。存在しないかパース失敗時はnull
 */
function _getSetting(key) {
    try {
        const settings = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
        return settings[key] !== undefined ? settings[key] : null;
    } catch (e) {
        console.error('Failed to parse localStorage settings:', e);
        return null; // パース失敗時は空オブジェクトとして扱う
    }
}

/**
 * localStorageに設定を保存する。
 * @param {string} key - 保存する設定のキー
 * @param {any} value - 保存する値
 */
function _setSetting(key, value) {
    try {
        const settings = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
        settings[key] = value;
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to save localStorage settings:', e);
    }
}

/**
 * localStorageから設定を削除する。
 * @param {string} key - 削除する設定のキー
 */
function _removeSetting(key) {
    try {
        const settings = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '{}');
        delete settings[key];
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.error('Failed to remove localStorage setting:', e);
    }
}

// --- GISスクリプト読み込み ---

/**
 * Google Identity Services (GIS) のスクリプトを読み込む（多重読み込みしない）。
 * @returns {Promise<void>} GISスクリプトの読み込みが完了したら解決するPromise
 */
export async function loadGis() {
    if (_gisLoaded) {
        return;
    }

    if (typeof window.google !== 'undefined' && typeof window.google.accounts !== 'undefined') {
        _gisLoaded = true;
        return;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.onload = () => {
            _gisLoaded = true;
            resolve();
        };
        script.onerror = () => {
            reject(new Error('Google Identity Servicesの読み込みに失敗しました。'));
        };
        document.head.appendChild(script);
    });
}

// --- OAuth関連関数 ---

/**
 * GISが読み込まれ、クライアントIDが設定済みかどうかを判定する。
 * @returns {boolean} 設定済みなら true
 */
export function isConfigured() {
    // 「クライアントIDが登録済みか」だけを見る。
    // GISスクリプトの読み込み状況は別物なので混ぜない
    // （混ぜると、ID保存直後にまだ「未設定」と表示されてしまう）。
    return !!_getSetting('googleClientId');
}

/**
 * Google Identity Services のスクリプトが読み込み済みかどうか。
 * @returns {boolean}
 */
export function isGisReady() {
    return _gisLoaded;
}

/**
 * 現在サインイン済み（有効なアクセストークンを保持）かどうかを判定する。
 * @returns {boolean} サインイン済みでトークンが有効期限内なら true
 */
export function isSignedIn() {
    // 期限切れの60秒前を有効期限とする
    return !!_accessToken && (_tokenExpiresAt > Date.now() + 60 * 1000);
}

/**
 * サインインしてアクセストークンを取得する。
 * @param {string} clientId - OAuthクライアントID
 * @param {boolean} interactive - true なら同意画面を出す（ユーザー操作から呼ぶこと）。
 *                                false なら無音での再取得を試みる（prompt: ''）。
 * @returns {Promise<boolean>} 取得できたら true、失敗したら false
 */
export async function signIn(clientId, interactive) {
    if (!clientId) {
        throw new Error('GoogleクライアントIDが設定されていません。設定画面で登録してください。');
    }
    _setSetting('googleClientId', clientId); // クライアントIDを保存

    await loadGis();

    // クライアントIDが変わったらトークンクライアントを作り直す
    // （初回に作ったIDのまま固定されてしまうのを防ぐ）
    if (_tokenClient && _tokenClientId !== clientId) {
        _tokenClient = null;
    }

    if (!_tokenClient) {
        _tokenClientId = clientId;
        _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_SCOPE,
            callback: (resp) => {
                // このコールバックはPromiseを返さないため、外部のPromiseを解決/拒否する
                if (resp.error) {
                    _tokenClient._reject(new Error(`OAuthエラー: ${resp.error} - ${resp.error_description}`));
                } else {
                    _accessToken = resp.access_token;
                    // expires_in は秒単位なのでミリ秒に変換
                    _tokenExpiresAt = Date.now() + (parseInt(resp.expires_in, 10) * 1000);
                    _tokenClient._resolve(true);
                }
            },
            error_callback: (error) => {
                _tokenClient._reject(new Error(`OAuthエラー: ${error.type} - ${error.message}`));
            }
        });
    }

    // requestAccessTokenをPromiseでラップ
    return new Promise((resolve, reject) => {
        _tokenClient._resolve = resolve;
        _tokenClient._reject = reject;
        _tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
    }).then((success) => {
        // 注意: メールアドレスは取得しない。
        // userinfo エンドポイントには 'openid' / 'userinfo.email' スコープが必要で、
        // このアプリは drive.file だけしか要求しない方針のため、あえて問い合わせない。
        _email = null;
        return success;
    }).catch((e) => {
        console.error('Sign-in failed:', e);
        _accessToken = null;
        _tokenExpiresAt = 0;
        _email = null;
        return false;
    });
}

/**
 * トークンを破棄し、サインアウトする（google.accounts.oauth2.revoke も呼ぶ）。
 * @returns {Promise<void>}
 */
export async function signOut() {
    if (_accessToken) {
        try {
            // GIS が用意している revoke を使う（CORSの都合で自前fetchより確実）
            if (window.google?.accounts?.oauth2?.revoke) {
                await new Promise((resolve) => {
                    google.accounts.oauth2.revoke(_accessToken, () => resolve());
                });
            }
        } catch (e) {
            console.warn('Failed to revoke token:', e);
        }
    }
    _accessToken = null;
    _tokenExpiresAt = 0;
    _email = null;
    // localStorageのclientIdは残しておく（次回ログイン時に再利用するため）
}

// --- 共通のfetchヘルパー ---

/**
 * Google Drive APIへのリクエストを送信するヘルパー関数。
 * 認証ヘッダーを付与し、エラーハンドリングと401リトライを行う。
 * @param {string} url - リクエストURL
 * @param {object} options - fetchオプション
 * @param {boolean} retryOn401 - 401エラー時に無音サインインを試みて再試行するかどうか (デフォルト: true)
 * @returns {Promise<object|string>} レスポンスボディ（JSONまたはテキスト）
 * @throws {Error} ネットワークエラーまたはAPIエラーが発生した場合
 */
async function driveFetch(url, options = {}, retryOn401 = true) {
    if (!isSignedIn()) {
        throw new Error('Googleにログインしていません。設定画面からログインしてください。');
    }

    const headers = {
        'Authorization': `Bearer ${_accessToken}`,
        ...options.headers
    };

    try {
        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 && retryOn401) {
            console.warn('401 Unauthorized. Attempting silent re-authentication...');
            const clientId = _getSetting('googleClientId');
            if (clientId && await signIn(clientId, false)) { // 無音サインインを試みる
                console.log('Silent re-authentication successful. Retrying request...');
                // 再試行時は401リトライを無効にする（無限ループ防止）
                return driveFetch(url, options, false);
            } else {
                throw new Error('Googleの認証が切れました。もう一度ログインしてください。');
            }
        }

        if (!response.ok) {
            let errorMessage = `Google Drive APIエラー: ${response.status}`;
            switch (response.status) {
                case 401: // retryOn401がfalseの場合、または再試行後も失敗した場合
                    errorMessage = 'Googleの認証が切れました。もう一度ログインしてください。';
                    break;
                case 403:
                    errorMessage = 'Google Driveへのアクセスが拒否されました。権限を確認してください。';
                    break;
                case 404:
                    errorMessage = '指定されたファイルまたはフォルダが見つかりません。';
                    break;
                case 429:
                case 500:
                case 502:
                case 503:
                case 504:
                    errorMessage = 'Google Drive側が混み合っています。しばらく待って再試行してください。';
                    break;
                default:
                    try {
                        const errorBody = await response.json();
                        errorMessage = errorBody.error?.message || errorMessage;
                    } catch (e) {
                        // JSONパース失敗時はデフォルトメッセージ
                    }
            }
            throw new Error(errorMessage);
        }

        const contentType = response.headers.get('Content-Type');
        if (contentType && contentType.includes('application/json')) {
            return response.json();
        } else {
            return response.text();
        }
    } catch (e) {
        if (e instanceof TypeError && e.message === 'Failed to fetch') {
            throw new Error('通信に失敗しました。オフラインの可能性があります。');
        }
        throw e;
    }
}

// --- Drive操作関数 ---

/**
 * 保存先ファイルを用意する（無ければフォルダ・ファイルを作成する）。
 * @returns {Promise<{folderId:string, fileId:string}>} フォルダIDとファイルIDを含むオブジェクト
 * @throws {Error} 認証エラーやAPIエラーが発生した場合
 */
export async function ensureDataFile() {
    let folderId = _getSetting('driveFolderId');
    let fileId = _getSetting('driveFileId');

    // 1. fileIdの生存確認
    if (fileId) {
        try {
            const fileMeta = await driveFetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,trashed`
            );
            if (fileMeta.trashed) {
                console.warn(`Existing fileId ${fileId} is trashed. Discarding.`);
                fileId = null;
                _removeSetting('driveFileId');
            } else {
                console.log(`Existing fileId ${fileId} is valid.`);
            }
        } catch (e) {
            console.warn(`Failed to validate existing fileId ${fileId}:`, e);
            fileId = null;
            _removeSetting('driveFileId');
            // 404 Not Foundの場合もここで処理される
        }
    }

    // 2. folderIdの生存確認、またはフォルダ作成
    if (folderId) {
        try {
            const folderMeta = await driveFetch(
                `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,trashed`
            );
            if (folderMeta.trashed) {
                console.warn(`Existing folderId ${folderId} is trashed. Discarding.`);
                folderId = null;
                _removeSetting('driveFolderId');
            } else {
                console.log(`Existing folderId ${folderId} is valid.`);
            }
        } catch (e) {
            console.warn(`Failed to validate existing folderId ${folderId}:`, e);
            folderId = null;
            _removeSetting('driveFolderId');
        }
    }

    // 2b. ローカルにfolderIdの記憶が無い端末（＝この端末で初回）でも、
    //     他の端末が既に作った同名フォルダをまず検索する。
    //     これをせずにいきなり新規作成すると、端末ごとに別々のフォルダ・別々の
    //     ファイルができてしまい、何回同期してもお互いのデータが一切見えなくなる。
    if (!folderId) {
        console.log(`Searching for existing folder: ${FOLDER_NAME}`);
        const folderQuery = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`;
        const folderSearch = await driveFetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(folderQuery)}&fields=files(id,name)&spaces=drive`
        );
        if (folderSearch.files && folderSearch.files.length > 0) {
            folderId = folderSearch.files[0].id;
            _setSetting('driveFolderId', folderId);
            console.log(`Found existing folder with ID: ${folderId}`);
        }
    }

    if (!folderId) {
        console.log(`Creating new folder: ${FOLDER_NAME}`);
        const folderMetadata = {
            name: FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder'
        };
        const newFolder = await driveFetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(folderMetadata)
        });
        folderId = newFolder.id;
        _setSetting('driveFolderId', folderId);
        console.log(`Folder created with ID: ${folderId}`);
    }

    // 3. フォルダ内に既存のai-news-data.jsonが無いか検索
    if (!fileId) {
        console.log(`Searching for existing file: ${DATA_FILENAME} in folder ${folderId}`);
        const query = `'${folderId}' in parents and name='${DATA_FILENAME}' and trashed=false`;
        const searchResult = await driveFetch(
            `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`
        );

        if (searchResult.files && searchResult.files.length > 0) {
            fileId = searchResult.files[0].id;
            _setSetting('driveFileId', fileId);
            console.log(`Found existing file with ID: ${fileId}`);
        }
    }

    // 4. 無ければ空のJSONファイルを新規作成
    if (!fileId) {
        console.log(`Creating new file: ${DATA_FILENAME} in folder ${folderId}`);
        const metadata = {
            name: DATA_FILENAME,
            parents: [folderId],
            mimeType: 'application/json'
        };
        const boundary = 'foo_bar_baz';
        const multipartBody = [
            `--${boundary}`,
            'Content-Type: application/json; charset=UTF-8',
            '',
            JSON.stringify(metadata),
            `--${boundary}`,
            'Content-Type: application/json',
            '',
            '{}', // 空のJSONデータ
            `--${boundary}--`
        ].join('\r\n');

        const newFile = await driveFetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
            {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: multipartBody
            }
        );
        fileId = newFile.id;
        _setSetting('driveFileId', fileId);
        console.log(`File created with ID: ${fileId}`);
    }

    return { folderId, fileId };
}

/**
 * ダイジェストデータをDriveへアップロード（上書き保存）する。
 * @param {object} payload - そのままJSONとして書き込むオブジェクト
 * @returns {Promise<{fileId:string, syncedAt:string}>} ファイルIDと同期日時を含むオブジェクト
 * @throws {Error} 認証エラーやAPIエラーが発生した場合
 */
export async function uploadData(payload) {
    const { fileId } = await ensureDataFile();

    const data = JSON.stringify(payload, null, 2);

    await driveFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
        {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json'
            },
            body: data
        }
    );

    // ローカル時刻のISO8601＋タイムゾーンオフセット形式を自前で組み立てる
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ms = now.getMilliseconds().toString().padStart(3, '0');

    const offsetMinutes = now.getTimezoneOffset();
    const offsetSign = offsetMinutes > 0 ? '-' : '+';
    const absOffsetMinutes = Math.abs(offsetMinutes);
    const offsetHours = Math.floor(absOffsetMinutes / 60).toString().padStart(2, '0');
    const offsetRemainingMinutes = (absOffsetMinutes % 60).toString().padStart(2, '0');
    const timezoneOffset = `${offsetSign}${offsetHours}:${offsetRemainingMinutes}`;

    const syncedAt = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${ms}${timezoneOffset}`;

    _setSetting('driveLastSyncedAt', syncedAt);

    return { fileId, syncedAt };
}

/**
 * Driveからダイジェストデータを取得する（機種変更・別端末での復元用）。
 * @returns {Promise<object|null>} payloadオブジェクト。ファイルが無ければ null
 * @throws {Error} 認証エラーやAPIエラーが発生した場合、またはJSONパース失敗時
 */
export async function downloadData() {
    const { fileId } = await ensureDataFile();

    if (!fileId) {
        return null; // ファイルIDが確定できない場合はデータなし
    }

    try {
        const data = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
        );

        // driveFetch は Content-Type が application/json のとき既にパース済みの
        // オブジェクトを返す。Driveはこのファイルを application/json で保存しているため、
        // 文字列前提で .trim() すると落ちる。両方のケースを受け止める。
        if (data === null || data === undefined) {
            return null;
        }
        if (typeof data === 'object') {
            return Object.keys(data).length === 0 ? null : data;
        }
        const text = String(data).trim();
        if (text === '' || text === '{}') {
            return null; // 作成直後の空ファイル
        }
        return JSON.parse(text);
    } catch (e) {
        if (e.message.includes('指定されたファイルまたはフォルダが見つかりません')) {
            // ファイルが存在しない場合はnullを返す
            return null;
        }
        throw new Error(`ダイジェストデータの読み込みに失敗しました: ${e.message}`);
    }
}

/**
 * 現在の同期状態をまとめて返す。
 * @returns {{ configured:boolean, signedIn:boolean, folderId:string|null,
 *             fileId:string|null, lastSyncedAt:string|null, email:string|null }}
 */
export function getStatus() {
    return {
        configured: isConfigured(),
        gisReady: isGisReady(),
        signedIn: isSignedIn(),
        folderId: _getSetting('driveFolderId'),
        fileId: _getSetting('driveFileId'),
        lastSyncedAt: _getSetting('driveLastSyncedAt'),
        email: _email
    };
}

/**
 * 記憶しているフォルダID・ファイルIDを消す（連携解除）。
 * これにより、次回アクセス時に新しいフォルダ・ファイルが作成されるか、
 * 既存のものが検索し直されます。
 */
export function clearDriveRefs() {
    _removeSetting('driveFolderId');
    _removeSetting('driveFileId');
    _removeSetting('driveLastSyncedAt');
    console.log('Google Drive references cleared from localStorage.');
}
