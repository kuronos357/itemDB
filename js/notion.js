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
   * NotionのURLまたは生のID文字列から正規の32桁データベースIDを抽出
   * 
   * 例:
   *  - https://app.notion.com/p/kuronos/3dc5e314fd47802eb00af61c71937780?v=3dc5e314fd47808f93c4000c6f793e02
   *  - https://www.notion.so/My-DB-3dc5e314fd47802eb00af61c71937780?v=...
   *  - 3dc5e314-fd47-802e-b00a-f61c71937780
   *  - 3dc5e314fd47802eb00af61c71937780
   */
  static extractDatabaseId(input) {
    if (!input) return '';
    const str = String(input).trim();

    // 1. URL形式の場合
    try {
      const url = new URL(str);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        // パス末尾の32桁Hex (slug-32hex または 32hex単体) を優先抽出
        const pathMatch = lastSegment.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/);
        if (pathMatch) {
          return pathMatch[1].replace(/-/g, '');
        }
      }
      // パスから取れず、?v= がある場合はそれを拾う
      const vParam = url.searchParams.get('v');
      if (vParam && /^[0-9a-fA-F]{32}$/.test(vParam)) {
        return vParam;
      }
    } catch {
      // URLでなければ文字列から正規表現検索
    }

    // 2. 文字列中に含まれる最初の32桁Hex (UUID)
    const match = str.match(/([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})/);
    if (match) {
      return match[1].replace(/-/g, '');
    }

    return str.replace(/-/g, '');
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

    // 2. それ以外（GitHub Pages や workers.dev、ローカル環境等）は corsproxy.io をフォールバック利用
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
        const err = new Error(msg);
        err.status = res.status;
        err.code = data?.code;
        throw err;
      }

      return data;
    } catch (err) {
      console.error('[NotionClient] Error requesting:', endpoint, err);
      // CORSブロック時の分かりやすい警告メッセージ付加
      if (err.message.includes('Failed to fetch') || err.name === 'TypeError') {
        throw new Error(`Notion APIへの通信に失敗しました (CORSまたはネットワーク障害)。設定画面でプロキシ設定を「CORS Proxy」に変更してください。`);
      }
      throw err;
    }
  }

  /**
   * データベース疎通テストおよびスキーマ情報の取得
   * (URLやView IDが入力された場合にも自動で子データベースを探索する耐障害性機能つき)
   */
  async testConnection() {
    const rawInput = state.config.dbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが設定されていません。');

    // URLまたは文字列からIDを抽出
    let targetId = NotionClient.extractDatabaseId(rawInput);

    // 1. まず抽出したIDでデータベース取得を試みる
    try {
      const data = await this._request(`databases/${targetId}`, { method: 'GET' });
      return {
        id: data.id,
        title: data.title?.[0]?.plain_text || '名称未設定',
        properties: Object.keys(data.properties || {})
      };
    } catch (err) {
      // 404の場合、URLに含まれる ?v= (ビューID) や親ページ側の子DBを探す
      if (err.status === 404 || err.message.includes('404')) {
        // パスがURLだった場合、?v= パラメータも試す
        try {
          const url = new URL(rawInput);
          const vParam = url.searchParams.get('v');
          if (vParam && vParam !== targetId) {
            const vData = await this._request(`databases/${vParam}`, { method: 'GET' });
            // 成功した場合はstateを正しいIDに更新
            state.saveConfig({ dbId: vParam });
            return {
              id: vData.id,
              title: vData.title?.[0]?.plain_text || '名称未設定',
              properties: Object.keys(vData.properties || {})
            };
          }
        } catch {}

        // 親ページとして子データベースブロックが存在しないか探索
        try {
          const blocks = await this._request(`blocks/${targetId}/children`, { method: 'GET' });
          const childDb = blocks.results?.find(b => b.type === 'child_database');
          if (childDb) {
            const dbData = await this._request(`databases/${childDb.id}`, { method: 'GET' });
            state.saveConfig({ dbId: childDb.id.replace(/-/g, '') });
            return {
              id: dbData.id,
              title: dbData.title?.[0]?.plain_text || childDb.child_database?.title || 'インラインデータベース',
              properties: Object.keys(dbData.properties || {})
            };
          }
        } catch {}

        throw new Error(`データベースが見つかりません (HTTP 404)。Notionのデータベース画面で「…」メニューからインテグレーション（コネクト）を追加・共有しているか確認してください。`);
      }
      throw err;
    }
  }

  /**
   * 数字IDからレコードを検索 (物品または場所)
   */
  async findRecordById(numericId) {
    const rawInput = state.config.dbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが未設定です。');
    const cleanDbId = NotionClient.extractDatabaseId(rawInput);

    const idNum = Number(numericId);
    const idStr = String(numericId);

    const body = {
      filter: {
        or: [
          {
            property: state.config.propMapping.id,
            number: { equals: idNum }
          },
          {
            property: state.config.propMapping.id,
            rich_text: { equals: idStr }
          },
          {
            property: state.config.propMapping.title,
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
    const rawInput = state.config.dbId;
    const cleanDbId = NotionClient.extractDatabaseId(rawInput);

    const body = {
      filter: {
        property: state.config.propMapping.location,
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
    const rawInput = state.config.dbId;
    const cleanDbId = NotionClient.extractDatabaseId(rawInput);

    const idNum = Number(numericId);
    const properties = {
      [state.config.propMapping.title]: {
        title: [
          { text: { content: name || `${isItem ? '物品' : '場所'} ${numericId}` } }
        ]
      },
      [state.config.propMapping.id]: {
        number: idNum
      }
    };

    if (state.config.propMapping.type) {
      properties[state.config.propMapping.type] = {
        select: { name: isItem ? '物品' : '場所' }
      };
    }

    if (isItem && locationPageId && state.config.propMapping.location) {
      properties[state.config.propMapping.location] = {
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
   * Notionのネストされたプロパティを正規化
   */
  _normalizeRecord(page) {
    const { propMapping } = state.config;
    const props = page.properties || {};

    let idVal = null;
    const idProp = props[propMapping.id];
    if (idProp) {
      if (idProp.type === 'number') idVal = idProp.number;
      else if (idProp.type === 'rich_text') idVal = idProp.rich_text?.[0]?.plain_text;
      else if (idProp.type === 'title') idVal = idProp.title?.[0]?.plain_text;
    }

    let titleVal = '';
    const titleProp = props[propMapping.title];
    if (titleProp && titleProp.title) {
      titleVal = titleProp.title.map(t => t.plain_text).join('');
    }

    let locationRelation = [];
    const locProp = props[propMapping.location];
    if (locProp && locProp.type === 'relation') {
      locationRelation = locProp.relation || [];
    }

    let statusVal = '';
    const statusProp = props[propMapping.status];
    if (statusProp) {
      if (statusProp.type === 'status') statusVal = statusProp.status?.name || '';
      else if (statusProp.type === 'select') statusVal = statusProp.select?.name || '';
    }

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
