/**
 * itemDB - Notion API Client
 * 
 * Notion API (v1) との通信、CORS回避プロキシのハンドリング、
 * データベースのクエリおよびページプロパティの更新を担当します。
 */

import { state } from './state.js';

export class NotionClient {
  constructor() {
    this.version = '2022-06-28';
  }

  /**
   * 現在の設定に基づきプロキシまたは直通URLを構築
   */
  _buildUrl(endpoint) {
    const { proxyMode, customProxyUrl } = state.config;
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const notionDirectUrl = `https://api.notion.com/v1/${cleanEndpoint}`;

    if (proxyMode === 'direct') {
      return notionDirectUrl;
    }

    if (proxyMode === 'cloudflare') {
      // Cloudflare Pages Functions (/functions/api/[[path]].js)
      return `/api/${cleanEndpoint}`;
    }

    if (proxyMode === 'custom' && customProxyUrl) {
      const base = customProxyUrl.endsWith('/') ? customProxyUrl : `${customProxyUrl}/`;
      return `${base}${cleanEndpoint}`;
    }

    if (proxyMode === 'corsproxy') {
      return `https://corsproxy.io/?url=${encodeURIComponent(notionDirectUrl)}`;
    }

    // 'auto' 判定
    // 1. Cloudflare Pages 上 (pages.dev) で動いている場合は /api/ を使用
    if (window.location.hostname.endsWith('pages.dev')) {
      return `/api/${cleanEndpoint}`;
    }

    // 2. それ以外（GitHub Pages や ローカル環境等）は corsproxy.io をフォールバック利用
    return `https://corsproxy.io/?url=${encodeURIComponent(notionDirectUrl)}`;
  }

  _getHeaders() {
    const { apiKey } = state.config;
    if (!apiKey) {
      throw new Error('Notion APIキーが設定されていません。');
    }
    return {
      'Authorization': `Bearer ${apiKey.trim()}`,
      'Notion-Version': this.version,
      'Content-Type': 'application/json'
    };
  }

  async _request(endpoint, options = {}) {
    const url = this._buildUrl(endpoint);
    const headers = { ...this._getHeaders(), ...(options.headers || {}) };

    try {
      const res = await fetch(url, {
        ...options,
        headers
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        const msg = data?.message || data?.error || `HTTP ${res.status} ${res.statusText}`;
        throw new Error(msg);
      }

      return data;
    } catch (err) {
      console.error('[NotionClient] Error requesting:', endpoint, err);
      // CORSブロック時の分かりやすい警告メッセージ付加
      if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
        throw new Error(`Notion APIへの通信に失敗しました (CORSまたはネットワーク障害)。設定画面でプロキシ設定を確認してください。`);
      }
      throw err;
    }
  }

  /**
   * データベース疎通テストおよびスキーマ情報の取得
   */
  async testConnection() {
    const { dbId } = state.config;
    if (!dbId) throw new Error('データベースIDが設定されていません。');
    const cleanDbId = dbId.replace(/-/g, '');
    const data = await this._request(`databases/${cleanDbId}`, { method: 'GET' });
    return {
      id: data.id,
      title: data.title?.[0]?.plain_text || '名称未設定',
      properties: Object.keys(data.properties || {})
    };
  }

  /**
   * 数字IDからレコードを検索 (物品または場所)
   */
  async findRecordById(numericId) {
    const { dbId, propMapping } = state.config;
    if (!dbId) throw new Error('データベースIDが未設定です。');
    const cleanDbId = dbId.replace(/-/g, '');

    const idNum = Number(numericId);
    const idStr = String(numericId);

    // 数値プロパティまたはタイトル/リッチテキストの両方に対応するクエリフィルタ
    const body = {
      filter: {
        or: [
          {
            property: propMapping.id,
            number: { equals: idNum }
          },
          {
            property: propMapping.id,
            rich_text: { equals: idStr }
          },
          {
            property: propMapping.title,
            title: { equals: idStr }
          }
        ]
      },
      page_size: 1
    };

    const res = await this._request(`databases/${cleanDbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    if (!res.results || res.results.length === 0) {
      return null;
    }

    return this._normalizeRecord(res.results[0]);
  }

  /**
   * 指定した場所 (pageId) に現在置かれている物品一覧を取得
   */
  async queryItemsByLocation(locationPageId) {
    const { dbId, propMapping } = state.config;
    const cleanDbId = dbId.replace(/-/g, '');

    const body = {
      filter: {
        property: propMapping.location,
        relation: {
          contains: locationPageId
        }
      },
      page_size: 100
    };

    const res = await this._request(`databases/${cleanDbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    return (res.results || []).map(page => this._normalizeRecord(page));
  }

  /**
   * 物品の現在地（リレーション）を更新
   * @param {string} itemPageId - 更新する物品ページのID
   * @param {string|null} locationPageId - 移動先の場所ページID (nullの場合は解除)
   */
  async updateItemLocation(itemPageId, locationPageId) {
    const { propMapping } = state.config;

    const properties = {
      [propMapping.location]: {
        relation: locationPageId ? [{ id: locationPageId }] : []
      }
    };

    const res = await this._request(`pages/${itemPageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties })
    });

    return this._normalizeRecord(res);
  }

  /**
   * 新しい物品または場所レコードを作成
   */
  async createRecord({ numericId, name, isItem, locationPageId = null }) {
    const { dbId, propMapping } = state.config;
    const cleanDbId = dbId.replace(/-/g, '');

    const idNum = Number(numericId);
    const properties = {
      [propMapping.title]: {
        title: [
          { text: { content: name || `${isItem ? '物品' : '場所'} ${numericId}` } }
        ]
      },
      [propMapping.id]: {
        number: idNum
      }
    };

    // 種別プロパティがある場合
    if (propMapping.type) {
      properties[propMapping.type] = {
        select: { name: isItem ? '物品' : '場所' }
      };
    }

    // 物品かつ場所指定がある場合
    if (isItem && locationPageId && propMapping.location) {
      properties[propMapping.location] = {
        relation: [{ id: locationPageId }]
      };
    }

    const res = await this._request(`pages`, {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: cleanDbId },
        properties
      })
    });

    return this._normalizeRecord(res);
  }

  /**
   * Notionのネストされたプロパティをプレーンなオブジェクトに正規化
   */
  _normalizeRecord(page) {
    const { propMapping } = state.config;
    const props = page.properties || {};

    // ID取得
    let idVal = null;
    const idProp = props[propMapping.id];
    if (idProp) {
      if (idProp.type === 'number') idVal = idProp.number;
      else if (idProp.type === 'rich_text') idVal = idProp.rich_text?.[0]?.plain_text;
      else if (idProp.type === 'title') idVal = idProp.title?.[0]?.plain_text;
    }

    // タイトル (名前)
    let titleVal = '';
    const titleProp = props[propMapping.title];
    if (titleProp && titleProp.title) {
      titleVal = titleProp.title.map(t => t.plain_text).join('');
    }

    // 現在地 (リレーション)
    let locationRelation = [];
    const locProp = props[propMapping.location];
    if (locProp && locProp.type === 'relation') {
      locationRelation = locProp.relation || [];
    }

    // 状態
    let statusVal = '';
    const statusProp = props[propMapping.status];
    if (statusProp) {
      if (statusProp.type === 'status') statusVal = statusProp.status?.name || '';
      else if (statusProp.type === 'select') statusVal = statusProp.select?.name || '';
    }

    // メモ
    let notesVal = '';
    const notesProp = props[propMapping.notes];
    if (notesProp && notesProp.type === 'rich_text') {
      notesVal = notesProp.rich_text.map(t => t.plain_text).join('');
    }

    return {
      pageId: page.id,
      id: idVal,
      name: titleVal || `ID: ${idVal}`,
      locationPageIds: locationRelation.map(r => r.id),
      status: statusVal,
      notes: notesVal,
      url: page.url,
      rawProperties: props
    };
  }
}

export const notion = new NotionClient();
