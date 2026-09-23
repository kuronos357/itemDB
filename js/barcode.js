/**
 * itemDB - Barcode (JAN / ISBN) Lookup Service
 * 
 * ISBN（書籍）は openBD API、
 * JANコード（一般商品）は Open Food Facts API やフォールバック検索を使用して
 * 商品名・著者・出版社・書影（画像）を取得します。
 */

import { JevService } from './jev.js';

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

  /**
   * バーコードから商品・書籍情報を検索
   * @param {string} rawCode
   * @param {{ jevApiKey?: string, candidateAttributes?: string[], jevMaxAttributes?: number }} [options]
   * @returns {Promise<{
   *   code: string,
   *   isIsbn: boolean,
   *   title: string,
   *   author?: string,
   *   publisher?: string,
   *   coverUrl?: string,
   *   details: string,
   *   attributes: string[]
   * }>}
   */
  static async lookup(rawCode, options = {}) {
    const code = String(rawCode).replace(/[-\s]/g, '').trim();
    const isBook = this.isIsbn(code);

    if (isBook) {
      return await this._lookupIsbn(code);
    } else {
      const result = await this._lookupJan(code);
      const candidateAttrs = Array.isArray(options.candidateAttributes) ? options.candidateAttributes : [];

      if (options.jevApiKey && result.title && !result.title.startsWith('市販品 (JAN:') && candidateAttrs.length > 0) {
        try {
          const categories = await JevService.classify(
            result.title,
            options.jevApiKey,
            candidateAttrs,
            { maxAttributes: options.jevMaxAttributes }
          );
          if (Array.isArray(categories) && categories.length > 0) {
            result.attributes = categories;
          } else {
            result.attributes = candidateAttrs.includes('市販品') ? ['市販品'] : [];
          }
        } catch (e) {
          console.warn('[BarcodeService] Jev classification error:', e);
          result.attributes = candidateAttrs.includes('市販品') ? ['市販品'] : [];
        }
      } else {
        result.attributes = candidateAttrs.includes('市販品') ? ['市販品'] : [];
      }
      return result;
    }
  }

  /**
   * openBD API による書籍情報の検索
   */
  static async _lookupIsbn(isbn) {
    try {
      const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data[0] && data[0].summary) {
          const s = data[0].summary;
          const title = s.title || `書籍 (ISBN: ${isbn})`;
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
            title,
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

    // openBDでヒットしなかった場合のフォールバック
    return {
      code: isbn,
      isIsbn: true,
      title: `書籍 (ISBN: ${isbn})`,
      author: '',
      publisher: '',
      coverUrl: null,
      details: `ISBN: ${isbn}`,
      attributes: ['本']
    };
  }

  /**
   * JANコードによる一般商品情報の検索 (Open Food Facts / フォールバック)
   */
  static async _lookupJan(jan) {
    try {
      // Open Food Facts API (食品・日用品の一部をカバー)
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(jan)}.json`, {
        headers: { 'User-Agent': 'itemDB - Web - 1.0' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 1 && data.product) {
          const p = data.product;
          const title = p.product_name_ja || p.product_name || p.product_name_en || `市販品 (JAN: ${jan})`;
          const brand = p.brands || '';
          const quantity = p.quantity || '';
          const coverUrl = p.image_url || p.image_front_url || null;

          const detailLines = [`JAN: ${jan}`];
          if (brand) detailLines.push(`メーカー/ブランド: ${brand}`);
          if (quantity) detailLines.push(`容量/規格: ${quantity}`);

          return {
            code: jan,
            isIsbn: false,
            title,
            author: brand,
            publisher: brand,
            coverUrl,
            details: detailLines.join('\n'),
            attributes: ['市販品']
          };
        }
      }
    } catch (e) {
      console.warn('[BarcodeService] Open Food Facts lookup error:', e);
    }

    // 未ヒット時のフォールバック
    return {
      code: jan,
      isIsbn: false,
      title: `市販品 (JAN: ${jan})`,
      author: '',
      publisher: '',
      coverUrl: null,
      details: `JAN: ${jan}`,
      attributes: ['市販品']
    };
  }
}
