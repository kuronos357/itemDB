/**
 * itemDB - Jev (TypeSafe AI) Service
 * 
 * Jev System One API を呼び出し、Notion目録DBの既存タグから
 * 確率降順の「最大落差（エルボー法）」を用いて上位最大N件の属性を自動分類・抽出します。
 */

export class JevService {
  /**
   * Jev API のプロキシエンドポイントURLを取得
   * ローカル環境 (localhost / 127.0.0.1) の場合は本番の Cloudflare Pages プロキシを利用
   */
  static _getEndpointUrl() {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '') {
        return 'https://itemdb.pages.dev/api/jev';
      }
    }
    return '/api/jev';
  }

  /**
   * 商品名から属性・カテゴリを自動判定
   * 
   * @param {string} title 商品名
   * @param {string} apiKey Jev APIキー
   * @param {string[]} candidateOptions Notion側の属性選択肢（必須）
   * @param {{ maxAttributes?: number }} [options] 設定オプション（最大採用数 N件）
   * @returns {Promise<string[]>} 採用された属性名の配列
   */
  static async classify(title, apiKey, candidateOptions = [], options = {}) {
    if (!title || !apiKey) return [];

    // Notionの属性プロパティから取得した選択肢のみを使用する（余計なタグをNotionに増やさない）
    if (!candidateOptions || !Array.isArray(candidateOptions) || candidateOptions.length === 0) {
      return [];
    }

    const maxN = Math.max(1, parseInt(options.maxAttributes, 10) || 3);

    const criteria = {};
    for (const opt of candidateOptions) {
      criteria[opt] = `${opt}`;
    }

    const payload = {
      model: 'jev-latest',
      state: `商品名: ${title}`,
      questions: {
        category: {
          type: 'choice',
          instructions: '商品名に最も適合するカテゴリを1つ選択してください。',
          criteria
        }
      }
    };

    const primaryEndpoint = this._getEndpointUrl();

    try {
      let res = null;
      try {
        res = await fetch(primaryEndpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        if (primaryEndpoint !== 'https://itemdb.pages.dev/api/jev') {
          res = await fetch('https://itemdb.pages.dev/api/jev', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey.trim()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
        } else {
          throw netErr;
        }
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        console.warn('[JevService] Jev API error:', res.status, errData);
        return [];
      }

      const data = await res.json();
      const categoryAnswer = data?.answers?.category;
      if (!categoryAnswer) return [];

      // 確率辞書の取得 (probabilities または distribution)
      const probMap = categoryAnswer.probabilities || categoryAnswer.distribution || null;

      if (probMap && typeof probMap === 'object') {
        // 各候補の確率リスト（候補リストに実在するもののみ、降順ソート）
        const scores = candidateOptions.map(opt => ({
          option: opt,
          prob: typeof probMap[opt] === 'number' ? probMap[opt] : 0
        })).sort((a, b) => b.prob - a.prob);

        if (scores.length === 0 || scores[0].prob <= 0) {
          return [];
        }

        // 候補が1つの場合はそれをそのまま採用（上限N件フィルタ）
        if (scores.length === 1) {
          return [scores[0].option].slice(0, maxN);
        }

        /**
         * 確率の高い順に並べていき、落差（ギャップ: Δ_i = P_i - P_{i+1}）が
         * 一番大きい地点を閾値境界とし、そこより上（0 〜 cutOffIndex）を採用。
         */
        let maxGap = -1;
        let cutOffIndex = 0; // 採用する末尾インデックス

        for (let i = 0; i < scores.length - 1; i++) {
          const gap = scores[i].prob - scores[i + 1].prob;
          if (gap > maxGap) {
            maxGap = gap;
            cutOffIndex = i;
          }
        }

        // カットオフ地点までの候補を抽出し、上位最大N件のフィルタを適用
        const selected = scores
          .slice(0, cutOffIndex + 1)
          .map(item => item.option);

        return (selected.length > 0 ? selected : [scores[0].option]).slice(0, maxN);
      }

      // 確率辞書が得られなかった場合のフォールバック（単一choice / value / 文字列）
      let singleChoice = null;
      if (typeof categoryAnswer === 'string') {
        singleChoice = categoryAnswer;
      } else if (categoryAnswer && typeof categoryAnswer.choice === 'string') {
        singleChoice = categoryAnswer.choice;
      } else if (categoryAnswer && typeof categoryAnswer.value === 'string') {
        singleChoice = categoryAnswer.value;
      }

      if (singleChoice && candidateOptions.includes(singleChoice)) {
        return [singleChoice].slice(0, maxN);
      }

      return [];
    } catch (e) {
      console.warn('[JevService] Jev classification failed:', e);
      return [];
    }
  }

  /**
   * EC出品タイトルを単語分解し、Jev SystemOne で不要な宣伝・用途キーワードを除外して
   * スッキリした「メーカー名＋商品名＋型番・仕様」を抽出
   * 
   * @param {string} rawTitle ECモールの長文タイトル
   * @param {string} apiKey Jev APIキー
   * @returns {Promise<string>} 整形後の商品名
   */
  static async cleanProductTitle(rawTitle, apiKey) {
    if (!rawTitle || !apiKey) return rawTitle || '';

    // 読点、カンマ、括弧類の境界をスペース化してトークン分割
    const normalized = String(rawTitle)
      .replace(/[、，,]/g, ' ')
      .replace(/([【\[［\(（])/g, ' $1')
      .replace(/([】\]］\)）])/g, '$1 ');

    const tokens = normalized.split(/[\s　]+/).map(t => t.trim()).filter(Boolean);

    // 単語が短すぎる・少なすぎる場合はそのまま返却
    if (tokens.length <= 2 || rawTitle.length <= 20) {
      return rawTitle;
    }

    const questions = {};
    tokens.forEach((token, idx) => {
      questions['token_' + idx] = {
        type: 'choice',
        instructions: `商品名「${rawTitle}」に含まれる単語「${token}」を、目録・カタログ登録用の正規商品名（ブランド・商品本体名・型番・基本仕様）として残すべきか、用途・互換性・宣伝などの付加情報として除外すべきか判定してください。`,
        criteria: {
          '残す': 'メーカー・ブランド名、商品本体の名称（カメラ、洗剤、テープ等）、型番・品番、主要スペック（画素数、容量規格、サイズ、カラー、基本仕様）',
          '除外': '送料無料、セール、ポイント、個数・まとめ買い・セット数・ケース販売、新品中古状態、配送方法・即日発送、用途キーワード（産業用、ゴルフ等）、対応OSや対応機種・互換環境（Linux, Windows, Raspberry Pi等）、店舗名などの付加情報'
        }
      };
    });

    const payload = {
      model: 'jev-latest',
      state: '商品出品タイトル: ' + rawTitle,
      questions
    };

    const primaryEndpoint = this._getEndpointUrl();

    try {
      let res = null;
      try {
        res = await fetch(primaryEndpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        if (primaryEndpoint !== 'https://itemdb.pages.dev/api/jev') {
          res = await fetch('https://itemdb.pages.dev/api/jev', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey.trim()}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          });
        } else {
          throw netErr;
        }
      }

      if (!res.ok) {
        console.warn('[JevService] cleanProductTitle HTTP error:', res.status);
        return rawTitle;
      }

      const data = await res.json();
      const answers = data.answers || {};

      const keptTokens = [];
      tokens.forEach((token, idx) => {
        const ans = answers['token_' + idx];
        if (ans?.choice === '残す') {
          keptTokens.push(token);
        }
      });

      if (keptTokens.length === 0) {
        return rawTitle;
      }

      return keptTokens.join(' ');
    } catch (err) {
      console.warn('[JevService] cleanProductTitle failed:', err);
      return rawTitle;
    }
  }

  /**
   * Jev API の疎通テストを実行（カテゴリ分類および商品名整形の両方を検証）
   * @param {string} apiKey Jev APIキー
   * @returns {Promise<{ ok: boolean, duration?: number, message: string, details?: any }>}
   */
  static async testConnection(apiKey) {
    if (!apiKey || !apiKey.trim()) {
      return { ok: false, message: 'Jev APIキーが入力されていません。' };
    }

    const testPayload = {
      model: 'jev-latest',
      state: '商品名: コクヨ ドットライナー つめ替え用テープ 8.4mm×16m タ-D400-08N 10個セット [新品]',
      questions: {
        category: {
          type: 'choice',
          instructions: '商品名に最も適合するカテゴリを1つ選択してください。',
          criteria: {
            '文房具': 'ペン、テープ、ノート、文具全般',
            '日用品': '洗剤、生活雑貨、消耗品',
            '書籍': '本、雑誌、コミック'
          }
        },
        clean_check: {
          type: 'choice',
          instructions: '単語「[新品]」をカタログ登録用商品名として残すべきか判定してください。',
          criteria: {
            '残す': 'ブランド名、商品本体名、型番、基本仕様',
            '除外': '新品、中古、セール、個数、送料無料などの付加情報'
          }
        }
      }
    };

    const startTime = performance.now();
    const cleanKey = apiKey.trim();
    const primaryEndpoint = this._getEndpointUrl();

    const doRequest = async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(testPayload)
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    };

    try {
      let reqResult = null;
      let usedEndpoint = primaryEndpoint;

      try {
        reqResult = await doRequest(primaryEndpoint);
      } catch (networkErr) {
        if (primaryEndpoint !== 'https://itemdb.pages.dev/api/jev') {
          usedEndpoint = 'https://itemdb.pages.dev/api/jev';
          reqResult = await doRequest(usedEndpoint);
        } else {
          throw networkErr;
        }
      }

      const { res, data } = reqResult;

      if (!res.ok) {
        let errorDetail = '';
        if (Array.isArray(data?.detail)) {
          errorDetail = data.detail.map(d => `${d.loc ? d.loc.slice(1).join('.') + ': ' : ''}${d.msg}`).join(', ');
        } else if (data?.detail?.message) {
          errorDetail = data.detail.message;
        } else if (data?.detail && typeof data.detail === 'string') {
          errorDetail = data.detail;
        } else if (data?.error) {
          errorDetail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
        }

        let userMsg = `HTTP ${res.status}`;
        if (res.status === 401) {
          userMsg = errorDetail ? `認証エラー (401): ${errorDetail}` : 'APIキーが無効、または認証に失敗しました (401 Unauthorized)';
        } else if (res.status === 403) {
          userMsg = errorDetail ? `アクセス拒否 (403): ${errorDetail}` : 'アクセス権限がありません (403 Forbidden)';
        } else if (res.status === 429) {
          userMsg = errorDetail ? `利用制限 (429): ${errorDetail}` : 'リクエスト上限に達しました (429 Rate Limit)';
        } else if (errorDetail) {
          userMsg = `エラー (${res.status}): ${errorDetail}`;
        }

        return {
          ok: false,
          message: userMsg,
          details: { status: res.status, data, usedEndpoint }
        };
      }

      const duration = Math.round(performance.now() - startTime);
      const cat = data?.answers?.category?.choice || '判定完了';
      return {
        ok: true,
        duration,
        message: `接続成功 (${duration}ms): Jev AI (分類:「${cat}」/ タイトル単語判定) が正常動作しました。`,
        details: { usedEndpoint, answers: data?.answers }
      };
    } catch (err) {
      return {
        ok: false,
        message: `通信エラー: ${err.message}`,
        details: { error: err }
      };
    }
  }
}
