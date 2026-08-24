/**
 * @file Gemini API と連携し、AIニュースダイジェストを生成するモジュール。
 * @module gemini
 */

import { getLocalDateString } from './storage.js';

/**
 * Gemini API のデフォルトモデル名。
 * @type {string}
 * @constant
 */
export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * ナレーション原稿の目標文字数。日本語のTTSは1分あたり300〜400字程度なので、
 * 5000〜6000字でおよそ15分になる。
 * @type {number}
 * @constant
 */
export const TARGET_MIN_LENGTH = 5000;
/** @type {number} */
export const TARGET_MAX_LENGTH = 6000;

/**
 * 再生成（増補・短縮）を発動するしきい値。
 * 目標ちょうどを狙うと毎回もう1回APIを叩くことになり、生成時間と課金が倍になる。
 * 「聞ける尺」から外れたときだけ調整するよう、目標より緩めに取っている。
 * @type {number}
 * @constant
 */
const MIN_ACCEPTABLE_LENGTH = 3500;  // 約10分未満は短すぎる
/** @type {number} */
const MAX_ACCEPTABLE_LENGTH = 7500;  // 約21分超は長すぎる

/**
 * Gemini APIのエンドポイントURLを生成します。
 * @param {string} model - 使用するGeminiモデル名。
 * @returns {string} Gemini APIのエンドポイントURL。
 */
function _endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

/**
 * 与えられた文字列がGemini APIキーのように見えるか簡易的にチェックします。
 * 厳密なチェックではなく、ユーザーが誤って空のキーを保存しないためのヒントとして使用します。
 * @param {string} key - チェックするAPIキー文字列。
 * @returns {boolean} APIキーのように見える場合は true、そうでない場合は false。
 */
export function isApiKeyLooking(key) {
  if (typeof key !== 'string' || key.length < 20) {
    return false;
  }
  // Google APIキーは通常 'AIza' または 'AQ.' で始まる
  return key.startsWith('AIza') || key.startsWith('AQ.');
}

/**
 * Gemini APIを呼び出し、プロンプトに対するコンテンツを生成します。
 * @param {string} prompt - Geminiに送信するプロンプトテキスト。
 * @param {string} apiKey - Gemini APIキー。
 * @param {string} model - 使用するGeminiモデル名。
 * @param {boolean} useGrounding - Google Search grounding を使用するかどうか。
 * @param {AbortSignal} [signal] - リクエストを中断するための AbortSignal。
 * @returns {Promise<string>} 生成されたテキストコンテンツ。
 * @throws {Error} API呼び出しまたはレスポンス処理中にエラーが発生した場合。
 */
async function _callGemini(prompt, apiKey, model, useGrounding, signal) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 32768
    },
    ...(useGrounding ? { tools: [{ google_search: {} }] } : {})
  };

  try {
    const response = await fetch(_endpoint(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey // APIキーはヘッダーで渡す
      },
      body: JSON.stringify(body),
      signal: signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini APIエラー詳細:', errorText);
      let errorMessage = `Gemini APIエラー: ステータスコード ${response.status}。`;
      switch (response.status) {
        case 400:
          errorMessage = `リクエストが不正です。モデル名が正しいか確認してください。`;
          break;
        case 401:
        case 403:
          errorMessage = `APIキーが無効か、リファラー制限で拒否されました。設定を確認してください。`;
          break;
        case 429:
          errorMessage = `Gemini APIの利用上限に達しました。しばらく待って再試行してください。`;
          break;
        case 500:
        case 503:
          errorMessage = `Gemini APIサーバーで一時的な問題が発生しています。しばらく待って再試行してください。`;
          break;
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();

    const candidate = result?.candidates?.[0];
    const parts = candidate?.content?.parts;

    // partsが配列の場合、各partのtextを結合する (grounding使用時にpartsが分割されるため)
    const text = Array.isArray(parts)
      ? parts.map(p => (typeof p?.text === 'string' ? p.text : '')).join('')
      : '';

    if (!text) {
      throw new Error('Gemini APIからのレスポンスが空でした。しばらく待って再試行してください。');
    }

    if (candidate?.finishReason === 'MAX_TOKENS') {
      console.warn('Gemini API: 最大トークン数に達したため、レスポンスが途中で打ち切られました。');
    }

    return text;

  } catch (error) {
    if (error.name === 'AbortError') {
      // AbortError は呼び出し元で処理するため、そのまま再throw
      throw error;
    }
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      throw new Error('通信に失敗しました。オフラインの可能性があります。');
    }
    throw error;
  }
}

/**
 * 生成されたナレーション原稿を読み上げに適した形にクリーンアップします。
 * @param {string} text - クリーンアップするナレーション原稿。
 * @returns {string} クリーンアップされたナレーション原稿。
 */
function _cleanNarration(text) {
  let cleanedText = text;

  // 先頭・末尾の空白を除去
  cleanedText = cleanedText.trim();

  // 行頭の Markdown 記号 (#, *, -, +, >, およびそれに続く空白) を除去
  cleanedText = cleanedText.replace(/^(\s*)[#*+\->]\s*/gm, '$1');

  // Markdown の強調記号 (** __ `) を除去
  cleanedText = cleanedText.replace(/(\*\*|__|\`)/g, '');

  // 3つ以上連続する改行を2つに圧縮
  cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n');

  return cleanedText;
}

/**
 * ナレーション原稿が短すぎる場合に、Gemini APIを再度呼び出して増補します。
 * @param {string} narration - 現在のナレーション原稿。
 * @param {string} summarizedNews - ニュース要約。
 * @param {string} apiKey - Gemini APIキー。
 * @param {string} model - 使用するGeminiモデル名。
 * @param {AbortSignal} [signal] - リクエストを中断するための AbortSignal。
 * @returns {Promise<string>} 増補されたナレーション原稿、または元の原稿。
 */
async function _expandNarration(narration, summarizedNews, apiKey, model, signal) {
  const currentLength = narration.length;
  const expandPrompt = `
以下は本日のAIニュースのナレーション原稿ですが、目標の5000文字に対して${currentLength}文字と短すぎます。

同じ構成・同じ話し言葉（です・ます調）のまま、各トピックの背景・経緯・実務への影響の解説を厚くして、全体で5000文字以上6000文字程度になるよう書き直してください。

- 冒頭は『おはようございます、本日のAI関連ニュースをお伝えします』のまま、末尾は『以上、本日のAIニュースダイジェストでした』のままにしてください。
- 記号やMarkdown装飾は使わないでください。
- 同じ内容の言い換えによる水増しはせず、下記のニュース要約から拾えていない情報を追加して分量を満たしてください。

現在の原稿:
${narration}

参照できるニュース要約:
${summarizedNews}
`;

  try {
    const expandedNarration = await _callGemini(expandPrompt, apiKey, model, false, signal);
    const cleanedExpandedNarration = _cleanNarration(expandedNarration);
    // 増補結果が元の原稿より短い場合は、元の原稿を返す (劣化を防ぐ)
    if (cleanedExpandedNarration.length < narration.length) {
      console.warn('増補されたナレーションが元の原稿より短いため、元の原稿を維持します。');
      return narration;
    }
    return cleanedExpandedNarration;
  } catch (error) {
    console.warn('ナレーションの増補中にエラーが発生しました。元の原稿を返します。', error);
    return narration; // 増補失敗時は元の原稿を返す
  }
}

/**
 * ナレーション原稿が長すぎる場合に、Gemini APIを再度呼び出して尺に収めます。
 * （Geminiは文字数の自己申告が苦手で、放っておくと1万文字（約30分）まで膨らむ。
 *   プロンプトでの指定だけに頼らず、生成後に実測して詰め直す）
 * @param {string} narration - 現在のナレーション原稿。
 * @param {string} apiKey - Gemini APIキー。
 * @param {string} model - 使用するGeminiモデル名。
 * @param {AbortSignal} [signal] - リクエストを中断するための AbortSignal。
 * @returns {Promise<string>} 短縮されたナレーション原稿、または元の原稿。
 */
async function _condenseNarration(narration, apiKey, model, signal) {
  const currentLength = narration.length;
  const condensePrompt = `
以下は本日のAIニュースのナレーション原稿ですが、${currentLength}文字あり、目標の15分（5000〜6000文字）に対して長すぎます。

同じ構成・同じ話し言葉（です・ます調）のまま、全体で5000文字以上6000文字以内に収まるよう書き直してください。

- 重要度の低いトピックは丸ごと削ってください。全部を残そうとして各トピックを薄くするより、件数を減らして残したトピックの解説を保つほうが良いです。
- Claude・Anthropic関連は最優先で残してください。
- 冒頭は『おはようございます、本日のAI関連ニュースをお伝えします』のまま、末尾は『以上、本日のAIニュースダイジェストでした』のままにしてください。
- 記号やMarkdown装飾は使わないでください。

現在の原稿:
${narration}
`;

  try {
    const condensed = _cleanNarration(await _callGemini(condensePrompt, apiKey, model, false, signal));
    // 短縮できていない（むしろ長くなった）場合は元の原稿を返す
    if (condensed.length >= narration.length || condensed.length < 2000) {
      console.warn('短縮に失敗したため、元の原稿を維持します。');
      return narration;
    }
    return condensed;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    console.warn('ナレーションの短縮中にエラーが発生しました。元の原稿を返します。', error);
    return narration;
  }
}

/**
 * Gemini API を使用してAIニュースのダイジェストを生成します。
 * @param {string} apiKey - Gemini APIキー。
 * @param {object} [options] - オプション設定。
 * @param {string} [options.model=DEFAULT_MODEL] - 使用するGeminiモデル名。
 * @param {string} [options.today=getLocalDateString()] - 今日の日付 ('YYYY-MM-DD'形式)。
 * @param {function(number, string): void} [options.onProgress=null] - 進捗状況を通知するコールバック関数。
 * @param {AbortSignal} [options.signal] - リクエストを中断するための AbortSignal。
 * @returns {Promise<string>} 生成されたナレーション原稿。
 * @throws {Error} APIキーが設定されていない場合、またはAPI呼び出し中にエラーが発生した場合。
 */
export async function generateDigest(apiKey, options = {}) {
  const {
    model = DEFAULT_MODEL,
    today = getLocalDateString(),
    onProgress = null,
    signal
  } = options;

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('Gemini APIキーが設定されていません。設定画面で登録してください。');
  }
  if (!isApiKeyLooking(apiKey)) {
    console.warn('設定されているAPIキーは一般的なGemini APIキーの形式と異なります。キーが正しいか確認してください。');
  }

  // 1段階目: ニュース収集 (grounding あり)
  if (typeof onProgress === 'function') onProgress(1, 'AIニュースを収集しています…');
  const newsGatheringPrompt = `
あなたはAIニュースの専門家です。以下の情報源から直近24〜48時間以内の主要なAI関連ニュースや投稿を検索し、その内容を要約してください。特にClaude/Anthropic関連のニュースは最優先で詳細に扱ってください。

後続の日本語ナレーション生成で5000〜6000文字（読み上げて約15分）の原稿を作ります。それにちょうど見合う分量にしてください。以下を必ず守ってください。
- 拾うトピックは全体で10件から12件に絞ってください。多すぎても困ります。重要度の低いものは落としてください。
- そのうち3件程度はClaude・Anthropic関連にしてください（最優先）。
- 各トピックは2〜3文で書いてください。何が起きたかだけでなく、背景・これまでの経緯・実務やユーザーにとって何が変わるのかまで含めてください。単なる見出しの羅列にしないでください。
- 製品名・バージョン名・機能名・具体的な数字を省略せずに書いてください。
- 同じ内容の言い換えによる水増しはしないでください。分量は情報量で満たしてください。
- 各トピックの先頭に情報源名を書いてください。URLは含めないでください。

情報源:
- anthropic.com/news (Claude・Claude Code関連は最優先)
- openai.com/news
- simonwillison.net (実務者ブログ、具体的な検証記事を重視)
- news.ycombinator.com のAI関連トップ投稿
- Import AI (Jack ClarkのSubstackニュースレター)
- TLDR AI
- Ben's Bites
- The Neuron

今日の日付は ${today} です。
`;
  const summarizedNews = await _callGemini(newsGatheringPrompt, apiKey, model, true, signal);

  // 2段階目: ナレーション原稿作成 (grounding なし)
  if (typeof onProgress === 'function') onProgress(2, 'ナレーション原稿を作成しています…');
  const narrationGenerationPrompt = `
あなたはラジオニュースのナレーターです。以下のニュース要約を元に、15分前後で読み上げられる自然な話し言葉の日本語ナレーション原稿を作成してください。

分量の指定（最優先で守ってください）:
- 全体で5000文字以上6000文字以内にしてください。6000文字を超えてはいけません。
- 取り上げるトピックは10件程度に絞ってください。1トピックあたり400文字から500文字が目安です。
- 下のニュース要約に載っているトピックを全部詰め込む必要はありません。重要度の低いものは思い切って落としてください。網羅性より15分という尺を優先してください。
- Claude・Anthropic関連は最優先で、合わせて1500文字程度を割り当てて厚めに扱ってください。

その他の制約:
- 敬体（です・ます調）を使用してください。
- 記号やMarkdown装飾（#、*、|、箇条書きのハイフンなど）は一切使用しないでください。地の文だけで書いてください。
- URLは読み上げさせず、『詳細はニュースレターを参照』などの表現に留めてください。
- 各トピックについて、何が起きたかだけでなく、その背景、これまでの経緯、実務やユーザーにとって何が変わるのかまで解説してください。
- 同じ内容を言い換えて繰り返す水増しはしないでください。情報量で分量を満たしてください。
- 英語の製品名や略語は、初出時にカタカナ読みを添えるなど、耳で聞いて分かる表現にしてください。
- 音声で読み上げるため、一文は長くなりすぎないようにしてください。

構成:
- 『おはようございます、本日のAI関連ニュースをお伝えします』で始めてください。
- Claude/Anthropic関連のニュースを最優先で、最初に詳しく伝えてください。
- その後、その他の重要なニュースを重要度順に伝えてください。
- 各情報源については、『〜によりますと』『〜が伝えています』のように話し言葉で出典に触れてください。
- 話題が変わるところでは『続いてのニュースです』のような繋ぎの一文を入れてください。
- 『以上、本日のAIニュースダイジェストでした』で締めてください。

ニュース要約:
${summarizedNews}
`;
  let narration = await _callGemini(narrationGenerationPrompt, apiKey, model, false, signal);
  narration = _cleanNarration(narration);

  // 目標は5000〜6000文字（読み上げて約15分）。
  // Geminiは文字数の自己管理が苦手なので、生成後に実測して1回だけ調整する。
  // しきい値に余裕を持たせているのは、毎回2回目のAPI呼び出しが走ると
  // 生成時間と課金が倍になるため（多少のブレは許容する）。
  if (narration.length < MIN_ACCEPTABLE_LENGTH) {
    if (typeof onProgress === 'function') onProgress(3, '原稿が短いため、内容を増補しています…');
    narration = await _expandNarration(narration, summarizedNews, apiKey, model, signal);
  } else if (narration.length > MAX_ACCEPTABLE_LENGTH) {
    if (typeof onProgress === 'function') onProgress(3, '原稿が長いため、15分の尺に詰めています…');
    narration = await _condenseNarration(narration, apiKey, model, signal);
  }

  return narration;
}