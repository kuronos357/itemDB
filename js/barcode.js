/**
 * itemDB - Barcode (JAN / ISBN) Lookup Service
 * 
 * ISBN（書籍）は openBD API、
 * JANコード（一般商品）は Open Food Facts API やフォールバック検索を使用して
 * 商品名・著者・出版社・書影（画像）を取得します。
 */

import { JevService } from './jev.js';
import { GeminiService } from './gemini.js';

// クライアント側インメモリキャッシュ (同一バーコードの再読取ブレを完全に防止)
const CLIENT_JAN_CACHE = new Map();

export class BarcodeService {
  /**
   * スキャン文字列がバーコード（JAN/ISBN）かどうか判定
   * - 13桁数字 (EAN-13 / JAN-13 / ISBN-13)
   * - 8桁数字 (EAN-8 / JAN-8)
   * - 10桁 (ISBN-10)
   * - 12桁 (UPC-A)
   */
  static isBarcode(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();

    // 13桁数字 (ISBN: 978/979..., JAN: 45/49...)
    if (/^\d{13}$/.test(clean)) return true;

    // 8桁数字 (短縮JAN/EAN)
    if (/^\d{8}$/.test(clean)) return true;

    // 12桁数字 (UPC-A)
    if (/^\d{12}$/.test(clean)) return true;

    // 10桁ISBN (最後がXの場合あり)
    if (/^\d{9}[\dX]$/i.test(clean)) return true;

    return false;
  }

  /**
   * ISBN（書籍コード）かどうか判定
   */
  static isIsbn(code) {
    if (!code) return false;
    const clean = String(code).replace(/[-\s]/g, '').trim();
    if (clean.length === 13 && (clean.startsWith('978') || clean.startsWith('979'))) {
      return true;
    }
    if (clean.length === 10 && /^\d{9}[\dX]$/i.test(clean)) {
      return true;
    }
    return false;
  }

  static cleanProductName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.replace(/\s+/g, ' ').trim();
  }

  /**
   * バーコードから商品・書籍情報を検索
   */
  static async lookup(rawCode, options = {}) {
    const code = String(rawCode).replace(/[-\s]/g, '').trim();

    // キャッシュ確認 (取得済みの商品は即座に100%確実に返却)
    const cached = CLIENT_JAN_CACHE.get(code);
    if (cached) {
      return JSON.parse(JSON.stringify(cached));
    }

    const isBook = this.isIsbn(code);

    let result = null;
    if (isBook) {
      result = await this._lookupIsbn(code);
    } else {
      result = await this._lookupJan(code, options);
      const candidateAttrs = Array.isArray(options.candidateAttributes) ? options.candidateAttributes : [];

      // AI処理を並行実行 (商品名要約と属性分類を同時に行い、待ち時間を半減)
      const aiTasks = [];

      // 1. 商品名スマート整形 (Gemini): タイトルが長文(30文字以上)または記号が多い場合に優先実行
      if (options.geminiApiKey && result.title && !result.title.startsWith('市販品 (JAN:') && result.title.length > 25) {
        aiTasks.push(
          GeminiService.cleanProductTitle(result.title, options.geminiApiKey, options.geminiModel)
            .then(cleanTitle => {
              if (cleanTitle) result.title = cleanTitle;
            })
            .catch(geminiErr => {
              console.warn('[BarcodeService] Gemini title cleanup error:', geminiErr);
            })
        );
      }

      // 2. 属性（カテゴリ）自動分類 (Jev / Gemini): タイトル整形と同時に並行して実行
      if (candidateAttrs.length > 0 && result.title && !result.title.startsWith('市販品 (JAN:')) {
        const classifyTask = async () => {
          let classified = [];
          if (options.jevApiKey) {
            try {
              const cats = await JevService.classify(
                result.title,
                options.jevApiKey,
                candidateAttrs,
                { maxAttributes: options.jevMaxAttributes }
              );
              if (Array.isArray(cats) && cats.length > 0) classified = cats;
            } catch (e) {
              console.warn('[BarcodeService] Jev error:', e);
            }
          }
          if (classified.length === 0 && options.geminiApiKey) {
            try {
              const maxN = Math.max(1, parseInt(options.jevMaxAttributes, 10) || 3);
              const cats = await GeminiService.classifyAttributes(
                result.title,
                options.geminiApiKey,
                candidateAttrs,
                maxN,
                options.geminiModel
              );
              if (Array.isArray(cats) && cats.length > 0) classified = cats;
            } catch (e) {
              console.warn('[BarcodeService] Gemini classify error:', e);
            }
          }
          if (classified.length > 0) {
            result.attributes = classified;
          }
        };

        aiTasks.push(classifyTask());
      }

      if (aiTasks.length > 0) {
        await Promise.all(aiTasks);
      }

      if (!result.attributes || result.attributes.length === 0) {
        result.attributes = candidateAttrs.includes('市販品') ? ['市販品'] : [];
      }

      if (result && result.title) {
        CLIENT_JAN_CACHE.set(code, JSON.parse(JSON.stringify(result)));
      }

      return result;
    }
  }

  /**
   * openBD API および Google Books API による書籍情報の検索
   */
  static async _lookupIsbn(isbn) {
    // 1. openBD API (国内書籍の最高精度)
    try {
      const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data[0] && data[0].summary) {
          const s = data[0].summary;
          const title = s.title || '';
          const author = s.author || '';
          const publisher = s.publisher || '';
          const pubdate = s.pubdate || '';
          const coverUrl = s.cover || null;

          const detailLines = [`ISBN: ${isbn}`];
          if (author) detailLines.push(`著者: ${author}`);
          if (publisher) detailLines.push(`出版社: ${publisher}`);
          if (pubdate) detailLines.push(`刊行年月: ${pubdate}`);

          return {
            code: isbn,
            isIsbn: true,
            title: title || `書籍 (ISBN: ${isbn})`,
            author,
            publisher,
            coverUrl,
            details: detailLines.join('\n'),
            attributes: ['本']
          };
        }
      }
    } catch (e) {
      console.warn('[BarcodeService] openBD lookup error:', e);
    }

    // 2. Google Books API フォールバック (openBDに無い書籍・専門書・洋書に対応)
    try {
      const gRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
      if (gRes.ok) {
        const gData = await gRes.json();
        if (gData.items && gData.items.length > 0) {
          const vol = gData.items[0].volumeInfo || {};
          const title = vol.title || '';
          const author = Array.isArray(vol.authors) ? vol.authors.join(', ') : '';
          const publisher = vol.publisher || '';
          const pubdate = vol.publishedDate || '';
          let coverUrl = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail || null;
          if (coverUrl && coverUrl.startsWith('http://')) {
            coverUrl = coverUrl.replace('http://', 'https://');
          }

          const detailLines = [`ISBN: ${isbn}`];
          if (author) detailLines.push(`著者: ${author}`);
          if (publisher) detailLines.push(`出版社: ${publisher}`);
          if (pubdate) detailLines.push(`刊行年月: ${pubdate}`);

          return {
            code: isbn,
            isIsbn: true,
            title: title || `書籍 (ISBN: ${isbn})`,
            author,
            publisher,
            coverUrl,
            details: detailLines.join('\n'),
            attributes: ['本']
          };
        }
      }
    } catch (e) {
      console.warn('[BarcodeService] Google Books lookup error:', e);
    }

    // 3. 両方で見つからなかった場合のフォールバック（手入力を促す）
    return {
      code: isbn,
      isIsbn: true,
      title: '',
      author: '',
      publisher: '',
      coverUrl: null,
      details: `ISBN: ${isbn}`,
      attributes: ['本']
    };
  }

  /**
   * JANコードによる一般商品情報の検索 (Yahoo!ショッピングAPI / Open Food Facts / Google Books / Notion既存情報 / フォールバック)
   */
  static async _lookupJan(jan, options = {}) {
    // 1. Cloudflare Functions /api/jan (Yahoo!ショッピングAPI & サーバーサイド検索)
    try {
      const isLocal = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'));
      const janEndpoint = isLocal ? 'https://itemdb.pages.dev/api/jan' : '/api/jan';

      let apiMessage = '';
      const queryParams = new URLSearchParams({ code: jan });
      if (options.yahooAppId) {
        queryParams.set('appid', options.yahooAppId);
      }

      const res = await fetch(`${janEndpoint}?${queryParams.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.found && data.title) {
          const detailLines = [`JAN: ${jan}`];
          if (data.brand) detailLines.push(`メーカー/ブランド: ${data.brand}`);
          if (data.category) detailLines.push(`カテゴリ: ${data.category}`);
          if (data.price) detailLines.push(`参考価格: ${Number(data.price).toLocaleString()}円`);

          const attrs = [];
          if (data.category) {
            attrs.push(data.category);
          } else {
            attrs.push('市販品');
          }

          return {
            code: jan,
            isIsbn: data.category === '書籍' || data.source === 'googlebooks',
            title: this.cleanProductName(data.title),
            author: data.author || data.brand || '',
            publisher: data.brand || '',
            coverUrl: data.imageUrl || null,
            details: detailLines.join('\n'),
            attributes: attrs
          };
        } else {
          apiMessage = data.message || '';
          console.warn('[BarcodeService] /api/jan response:', data.message);
        }
      }
    } catch (e) {
      console.warn('[BarcodeService] /api/jan lookup error:', e);
    }

    // 2. 過去にNotionへ登録した同一JANコードの既存情報があれば優先補完
    if (options.existingRecord) {
      const ex = options.existingRecord;
      return {
        code: jan,
        isIsbn: false,
        title: ex.name || '',
        author: ex.author || '',
        publisher: ex.publisher || '',
        coverUrl: ex.coverUrl || null,
        details: ex.details || `JAN: ${jan}`,
        attributes: (ex.attributes && ex.attributes.length > 0) ? ex.attributes : ['市販品']
      };
    }

    // 3. Open Food Facts API 直接フォールバック (食品・日用品の一部をカバー)
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(jan)}.json`, {
        headers: { 'User-Agent': 'itemDB - Web - 1.0' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 1 && data.product) {
          const p = data.product;
          const title = p.product_name_ja || p.product_name || p.product_name_en || '';
          const brand = p.brands || '';
          const quantity = p.quantity || '';
          const coverUrl = p.image_url || p.image_front_url || null;

          const detailLines = [`JAN: ${jan}`];
          if (brand) detailLines.push(`メーカー/ブランド: ${brand}`);
          if (quantity) detailLines.push(`容量/規格: ${quantity}`);

          if (title) {
            return {
              code: jan,
              isIsbn: false,
              title: this.cleanProductName(title),
              author: brand,
              publisher: brand,
              coverUrl,
              details: detailLines.join('\n'),
              attributes: ['市販品']
            };
          }
        }
      }
    } catch (e) {
      console.warn('[BarcodeService] Open Food Facts lookup error:', e);
    }

    // 4. 書籍系JAN（978始まり以外の書籍や雑誌コード等）の可能性をGoogle Booksで確認
    try {
      const gRes = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(jan)}`);
      if (gRes.ok) {
        const gData = await gRes.json();
        if (gData.items && gData.items.length > 0) {
          const vol = gData.items[0].volumeInfo || {};
          const title = vol.title || '';
          const author = Array.isArray(vol.authors) ? vol.authors.join(', ') : '';
          const publisher = vol.publisher || '';
          const pubdate = vol.publishedDate || '';
          let coverUrl = vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail || null;
          if (coverUrl && coverUrl.startsWith('http://')) {
            coverUrl = coverUrl.replace('http://', 'https://');
          }

          const detailLines = [`JAN/ISBN: ${jan}`];
          if (author) detailLines.push(`著者: ${author}`);
          if (publisher) detailLines.push(`出版社: ${publisher}`);
          if (pubdate) detailLines.push(`刊行年月: ${pubdate}`);

          return {
            code: jan,
            isIsbn: true,
            title: title || '',
            author,
            publisher,
            coverUrl,
            details: detailLines.join('\n'),
            attributes: ['本']
          };
        }
      }
    } catch (e) {
      // 無視
    }

    // 5. 未ヒット時のフォールバック（手入力を促す）
    return {
      code: jan,
      isIsbn: false,
      title: '',
      author: '',
      publisher: '',
      coverUrl: null,
      details: `JAN: ${jan}`,
      attributes: ['市販品'],
      message: apiMessage
    };
  }
}
