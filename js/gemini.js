/**
 * itemDB - Google Gemini API Client (Gemini 3.1 Flash-Lite)
 * 
 * 長大なEC出品タイトルから余計な宣伝文句や用途を省いて
 * 純粋な「メーカー・ブランド名＋正式製品名＋型番」を美しく抽出するスマート要約と、
 * Notion属性の自動分類を高速に行います。
 */

import { state } from './state.js';

export class GeminiService {
  /**
   * 実行環境に応じたプロキシ/直通エンドポイントURLを決定
   */
  static _getEndpointUrl(model = null) {
    const targetModel = model || state.config?.geminiModel || 'gemini-3.1-flash-lite';
    if (typeof window === 'undefined') return `/api/gemini?model=${encodeURIComponent(targetModel)}`;
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return isLocal
      ? `https://itemdb.pages.dev/api/gemini?model=${encodeURIComponent(targetModel)}`
      : `/api/gemini?model=${encodeURIComponent(targetModel)}`;
  }

  /**
   * Gemini API を呼び出す低レベルメソッド
   */
  static async _generate(prompt, apiKey, options = {}) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('Gemini APIキーが指定されていません。');
    }

    const model = options.model || state.config?.geminiModel || 'gemini-3.1-flash-lite';
    const cleanKey = apiKey.trim();
    const endpoint = this._getEndpointUrl(model);

    const payload = {
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxOutputTokens ?? 256
      }
    };

    const doFetch = async (url) => {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cleanKey
        },
        body: JSON.stringify(payload)
      });
    };

    let res = null;
    let proxyError = null;
    try {
      res = await doFetch(endpoint);
      if (!res.ok) {
        proxyError = `Proxy HTTP ${res.status}`;
      }
    } catch (e) {
      proxyError = e.message;
    }

    // プロキシが未デプロイ(404等)または失敗した場合はGoogle直通エンドポイントへフォールバック
    if (!res || !res.ok) {
      const directUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cleanKey)}`;
      try {
        const directRes = await doFetch(directUrl);
        if (directRes.ok || !res) {
          res = directRes;
        }
      } catch (directErr) {
        if (!res) throw new Error(`通信失敗: ${proxyError || directErr.message}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        if (errJson?.error?.message) errMsg = errJson.error.message;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text || '';
    return text.trim();
  }

  /**
   * EC出品タイトルを整形し、スッキリした「メーカー名＋商品名＋型番」を抽出
   * 
   * @param {string} rawTitle ECモールの長文タイトル
   * @param {string} apiKey Gemini APIキー
   * @param {string} [model] 使用モデル名
   * @param {boolean} [throwOnError=false] エラー時に例外を再スローするか
   * @returns {Promise<string>} 整形後の商品名
   */
  static async cleanProductTitle(rawTitle, apiKey, model = null, throwOnError = false) {
    if (!rawTitle || !apiKey) return rawTitle || '';

    const prompt = `Clean this Japanese e-commerce title. Remove promos (free shipping, sale, new, bulk count), store tags, and bracketed notes.
Output ONLY the clean "Brand + Product Name + Model/Spec" in Japanese without quotes or explanations.

Title:
${rawTitle}`;

    try {
      const cleaned = await this._generate(prompt, apiKey, {
        model,
        temperature: 0.1,
        maxOutputTokens: 60
      });
      // 引用符や改行の除去
      const result = cleaned.replace(/^["'「`]|["'」`]$/g, '').replace(/\r?\n.*/s, '').trim();
      return result || rawTitle;
    } catch (err) {
      console.warn('[GeminiService] Clean title error:', err);
      if (throwOnError) throw err;
      return rawTitle;
    }
  }

  /**
   * Notionの属性候補から最適なカテゴリを自動分類
   * 
   * @param {string} title 商品名
   * @param {string} apiKey Gemini APIキー
   * @param {string[]} candidateAttributes Notionの属性候補リスト
   * @param {number} [maxN=3] 最大採用件数
   * @param {string} [model] 使用モデル名
   * @returns {Promise<string[]>}
   */
  static async classifyAttributes(title, apiKey, candidateAttributes = [], maxN = 3, model = null) {
    if (!title || !apiKey || !Array.isArray(candidateAttributes) || candidateAttributes.length === 0) {
      return [];
    }

    const prompt = `Select up to ${maxN} matching categories for this product from the allowed list.
Product: "${title}"
Allowed list: ${JSON.stringify(candidateAttributes)}

Output ONLY a JSON array containing exact matches from the allowed list, e.g. ["文房具", "日用品"]. If none match, output []. No extra text.`;

    try {
      const text = await this._generate(prompt, apiKey, {
        model,
        temperature: 0.1,
        maxOutputTokens: 40
      });
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          return arr.filter(item => candidateAttributes.includes(item)).slice(0, maxN);
        }
      }
      return [];
    } catch (err) {
      console.warn('[GeminiService] Classify error:', err);
      return [];
    }
  }

  /**
   * Gemini API 疎通テスト
   * @param {string} apiKey Gemini APIキー
   * @param {string} [model] 使用モデル名
   * @returns {Promise<{ ok: boolean, duration?: number, message: string }>}
   */
  static async testConnection(apiKey, model = null) {
    if (!apiKey || !apiKey.trim()) {
      return { ok: false, message: 'Gemini APIキーが入力されていません。' };
    }

    const targetModel = model || state.config?.geminiModel || 'gemini-3.1-flash-lite';
    const startTime = performance.now();
    try {
      const testTitle = '【送料無料】コクヨ ドットライナー つめ替え用テープ 8.4mm×16m タ-D400-08N 10個セット [新品]';
      const cleaned = await this.cleanProductTitle(testTitle, apiKey, targetModel, true);
      const duration = Math.round(performance.now() - startTime);

      if (cleaned === testTitle) {
        return {
          ok: false,
          message: `モデル「${targetModel}」からの応答がありませんでした（未整形）。APIキーまたはモデル名をご確認ください。`
        };
      }

      return {
        ok: true,
        duration,
        message: `接続成功 (${duration}ms, モデル: ${targetModel}): 「${cleaned}」にスマート整形されました。`
      };
    } catch (err) {
      return {
        ok: false,
        message: `接続エラー (${targetModel}): ${err.message}`
      };
    }
  }
}
