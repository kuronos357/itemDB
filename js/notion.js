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
    this._schemaCache = {};
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
   * データベースのスキーマ（プロパティ定義一覧）を取得・キャッシュ
   */
  async getDatabaseSchema(dbId = null, forceRefresh = false) {
    const rawInput = dbId || state.config.itemDbId || state.config.dbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが未設定です。');
    const cleanDbId = NotionClient.extractDatabaseId(rawInput);

    if (!forceRefresh && this._schemaCache[cleanDbId]) {
      return this._schemaCache[cleanDbId];
    }

    const data = await this._request(`databases/${cleanDbId}`, { method: 'GET' });
    const schema = {
      id: cleanDbId,
      title: data.title?.[0]?.plain_text || '名称未設定',
      properties: data.properties || {}
    };
    this._schemaCache[cleanDbId] = schema;
    return schema;
  }

  /**
   * 単一のURL/ID入力から、リレーション定義を解析して物品DBと場所DBを自動判別
   */
  async resolveDatabases(inputRaw) {
    if (!inputRaw) throw new Error('データベースのURLまたはIDが入力されていません。');
    let targetId = NotionClient.extractDatabaseId(inputRaw);

    // 1. 指定されたDBの情報を取得
    let dbData = null;
    try {
      dbData = await this._request(`databases/${targetId}`, { method: 'GET' });
    } catch (err) {
      // 404の場合、URLに含まれる ?v= (ビューID) や親ページ側の子DBを探す
      if (err.status === 404 || err.message?.includes('404')) {
        try {
          const url = new URL(inputRaw);
          const vParam = url.searchParams.get('v');
          if (vParam && vParam !== targetId) {
            dbData = await this._request(`databases/${vParam}`, { method: 'GET' });
            targetId = vParam;
          }
        } catch {}

        if (!dbData) {
          try {
            const blocks = await this._request(`blocks/${targetId}/children`, { method: 'GET' });
            const childDb = blocks.results?.find(b => b.type === 'child_database');
            if (childDb) {
              dbData = await this._request(`databases/${childDb.id}`, { method: 'GET' });
              targetId = childDb.id.replace(/-/g, '');
            }
          } catch {}
        }
      }
      if (!dbData) throw err;
    }

    const cleanTargetId = targetId.replace(/-/g, '');
    const titleA = dbData.title?.[0]?.plain_text || 'データベース';
    this._schemaCache[cleanTargetId] = {
      id: cleanTargetId,
      title: titleA,
      properties: dbData.properties || {}
    };

    // 2. リレーションプロパティを探索
    const props = dbData.properties || {};
    const relationProps = Object.values(props).filter(p => p.type === 'relation' && p.relation?.database_id);

    let itemDbInfo = null;
    let locationDbInfo = null;

    if (relationProps.length > 0) {
      // 関連するリレーションプロパティを選択
      const relProp = relationProps.find(p => ['現在地', '場所', '保管場所', '収納先'].includes(p.name))
        || relationProps.find(p => ['収容物', '物品', 'アイテム'].includes(p.name))
        || relationProps[0];

      const relatedDbId = relProp.relation.database_id.replace(/-/g, '');
      let titleB = '関連データベース';
      try {
        const relatedDbData = await this._request(`databases/${relatedDbId}`, { method: 'GET' });
        titleB = relatedDbData.title?.[0]?.plain_text || titleB;
        this._schemaCache[relatedDbId] = {
          id: relatedDbId,
          title: titleB,
          properties: relatedDbData.properties || {}
        };
      } catch (e) {
        console.warn('[NotionClient] リレーション先DBの取得に失敗:', e.message);
      }

      // どちらが物品DBでどちらが場所DBかを判定
      const lowerA = titleA.toLowerCase();
      const isAItem = /物|アイテム|item|ツール|tool|パーツ|part/.test(lowerA) ||
                      ['現在地', '場所', '保管場所', '収納先'].includes(relProp.name);
      const isALocation = /場|ロケーション|location|収納|棚|部屋|ボックス|box/.test(lowerA) ||
                          ['収容物', '物品', 'アイテム'].includes(relProp.name);

      if (isAItem && !isALocation) {
        itemDbInfo = { id: cleanTargetId, title: titleA };
        locationDbInfo = { id: relatedDbId, title: titleB };
      } else if (isALocation && !isAItem) {
        locationDbInfo = { id: cleanTargetId, title: titleA };
        itemDbInfo = { id: relatedDbId, title: titleB };
      } else {
        // デフォルト: 入力された方を物品DB、リンク先を場所DBとする
        itemDbInfo = { id: cleanTargetId, title: titleA };
        locationDbInfo = { id: relatedDbId, title: titleB };
      }
    } else {
      // リレーションがない場合は単一DBとして運用
      itemDbInfo = { id: cleanTargetId, title: titleA };
      locationDbInfo = { id: cleanTargetId, title: titleA };
    }

    // stateに保存
    state.saveConfig({
      dbId: cleanTargetId,
      itemDbId: itemDbInfo.id,
      locationDbId: locationDbInfo.id,
      itemDbTitle: itemDbInfo.title,
      locationDbTitle: locationDbInfo.title
    });

    return {
      itemDb: itemDbInfo,
      locationDb: locationDbInfo,
      isDual: itemDbInfo.id !== locationDbInfo.id
    };
  }

  /**
   * データベース疎通テスト（2つのDBの連携状況を診断）
   */
  async testConnection() {
    const rawInput = state.config.dbId || state.config.itemDbId || state.config.locationDbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが設定されていません。');

    return await this.resolveDatabases(rawInput);
  }

  /**
   * 数字IDからレコードを検索 (偶数=物品DB, 奇数=場所DB)
   */
  async findRecordById(numericId, isItem = null) {
    if (isItem === null) {
      isItem = (Number(numericId) % 2 === 0);
    }

    const primaryDbId = isItem
      ? (state.config.itemDbId || state.config.dbId)
      : (state.config.locationDbId || state.config.dbId);

    if (!primaryDbId) throw new Error('データベースのURLまたはIDが未設定です。');

    // 1. 本来の対象DBで検索
    let record = await this._queryDbForId(primaryDbId, numericId);
    if (record) return record;

    // 2. もし見つからず、2DB構成の場合はもう片方のDBもフォールバック検索
    const secondaryDbId = isItem
      ? state.config.locationDbId
      : state.config.itemDbId;

    if (secondaryDbId && secondaryDbId !== primaryDbId) {
      record = await this._queryDbForId(secondaryDbId, numericId);
      if (record) return record;
    }

    return null;
  }

  /**
   * 指定DBに対して型安全な単一ID検索を実行
   */
  async _queryDbForId(cleanDbId, numericId) {
    const idNum = Number(numericId);
    const idStr = String(numericId);

    let schema = null;
    try {
      schema = await this.getDatabaseSchema(cleanDbId);
    } catch (e) {
      console.warn('[NotionClient] スキーマ取得スキップ (フォールバック使用):', e.message);
    }

    const props = schema?.properties || {};
    const configuredIdPropName = state.config.propMapping.id || 'ID';

    let matchedProp = props[configuredIdPropName];
    let actualPropName = configuredIdPropName;

    if (!matchedProp) {
      const lowerConfig = configuredIdPropName.toLowerCase();
      const foundEntry = Object.entries(props).find(([k]) => k.toLowerCase() === lowerConfig)
        || Object.entries(props).find(([k]) => ['id', '物品id', '場所id', '管理番号', 'no', 'code'].includes(k.toLowerCase()))
        || Object.entries(props).find(([, p]) => p.type === 'number' || p.type === 'unique_id');

      if (foundEntry) {
        actualPropName = foundEntry[0];
        matchedProp = foundEntry[1];
      }
    }

    let propType = matchedProp?.type || 'number';

    const buildFilter = (name, type) => {
      if (type === 'number') return { property: name, number: { equals: idNum } };
      if (type === 'unique_id') return { property: name, unique_id: { equals: idNum } };
      if (type === 'rich_text' || type === 'text') return { property: name, rich_text: { equals: idStr } };
      if (type === 'title') return { property: name, title: { equals: idStr } };
      return { property: name, number: { equals: idNum } };
    };

    let queryFilter = buildFilter(actualPropName, propType);

    let res = null;
    try {
      res = await this._request(`databases/${cleanDbId}/query`, {
        method: 'POST',
        body: JSON.stringify({ filter: queryFilter, page_size: 1 })
      });
    } catch (err) {
      const match = err.message && err.message.match(/database property (\w+) does not match filter (\w+)/i);
      if (match) {
        const correctType = match[1].toLowerCase();
        console.warn(`[NotionClient] プロパティ型を自動補正して再試行: ${propType} -> ${correctType}`);
        const fixedFilter = buildFilter(actualPropName, correctType);
        res = await this._request(`databases/${cleanDbId}/query`, {
          method: 'POST',
          body: JSON.stringify({ filter: fixedFilter, page_size: 1 })
        });
      } else {
        throw err;
      }
    }

    if (res?.results && res.results.length > 0) {
      return this._normalizeRecord(res.results[0]);
    }

    // タイトル検索フォールバック
    const titleProp = Object.values(props).find(p => p.type === 'title');
    if (titleProp && titleProp.name !== actualPropName) {
      try {
        const titleRes = await this._request(`databases/${cleanDbId}/query`, {
          method: 'POST',
          body: JSON.stringify({
            filter: { property: titleProp.name, title: { equals: idStr } },
            page_size: 1
          })
        });
        if (titleRes?.results && titleRes.results.length > 0) {
          return this._normalizeRecord(titleRes.results[0]);
        }
      } catch {}
    }

    return null;
  }

  /**
   * 単一ページ（Page）の取得
   */
  async fetchPage(pageId) {
    if (!pageId) return null;
    const cleanId = pageId.replace(/-/g, '');
    const data = await this._request(`pages/${cleanId}`, { method: 'GET' });
    return this._normalizeRecord(data);
  }

  /**
   * 指定した場所 (pageId) に現在置かれている物品一覧を取得 (物品DBをクエリ)
   */
  async queryItemsByLocation(locationPageId) {
    const itemDbId = state.config.itemDbId || state.config.dbId;
    if (!itemDbId) return [];

    let locPropName = state.config.propMapping.location || '現在地';
    try {
      const schema = await this.getDatabaseSchema(itemDbId);
      const props = schema?.properties || {};
      if (!props[locPropName] || props[locPropName].type !== 'relation') {
        const foundRel = Object.values(props).find(p => p.type === 'relation');
        if (foundRel) locPropName = foundRel.name;
      }
    } catch {}

    const body = {
      filter: {
        property: locPropName,
        relation: {
          contains: locationPageId
        }
      },
      page_size: 100
    };

    const res = await this._request(`databases/${itemDbId}/query`, {
      method: 'POST',
      body: JSON.stringify(body)
    });

    return (res.results || []).map(page => this._normalizeRecord(page));
  }

  /**
   * 物品の現在地（リレーション）を更新 (物品DBのページをPATCH)
   */
  async updateItemLocation(itemPageId, locationPageId) {
    const itemDbId = state.config.itemDbId || state.config.dbId;
    let locPropName = state.config.propMapping.location || '現在地';
    try {
      const schema = await this.getDatabaseSchema(itemDbId);
      const props = schema?.properties || {};
      if (!props[locPropName] || props[locPropName].type !== 'relation') {
        const foundRel = Object.values(props).find(p => p.type === 'relation');
        if (foundRel) locPropName = foundRel.name;
      }
    } catch {}

    const properties = {
      [locPropName]: {
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
   * 新しい物品または場所レコードを作成 (適切なDBへルーティング)
   */
  async createRecord({ numericId, name, isItem, locationPageId = null }) {
    const targetDbId = isItem
      ? (state.config.itemDbId || state.config.dbId)
      : (state.config.locationDbId || state.config.dbId);

    if (!targetDbId) throw new Error('作成先データベースが未設定です。');

    const idNum = Number(numericId);
    const idStr = String(numericId);

    let schema = null;
    try {
      schema = await this.getDatabaseSchema(targetDbId);
    } catch {}
    const props = schema?.properties || {};

    // 1. Titleプロパティ特定
    let titlePropName = state.config.propMapping.title || '名前';
    const foundTitleProp = Object.values(props).find(p => p.type === 'title');
    if (foundTitleProp) {
      titlePropName = foundTitleProp.name;
    }

    // 2. IDプロパティ特定
    let idPropName = state.config.propMapping.id || 'ID';
    let idPropType = 'number';
    if (props[idPropName]) {
      idPropType = props[idPropName].type;
    } else {
      const foundId = Object.values(props).find(p => ['id', '物品id', '場所id', '管理番号', 'no'].includes(p.name.toLowerCase()) || p.type === 'number');
      if (foundId) {
        idPropName = foundId.name;
        idPropType = foundId.type;
      }
    }

    const properties = {
      [titlePropName]: {
        title: [
          { text: { content: name || `${isItem ? '物品' : '場所'} ${numericId}` } }
        ]
      }
    };

    // IDの設定
    if (idPropType === 'number') {
      properties[idPropName] = { number: idNum };
    } else if (idPropType === 'rich_text') {
      properties[idPropName] = { rich_text: [{ text: { content: idStr } }] };
    }

    // 3. 種別 (Type) プロパティが存在する場合のみ設定
    let typePropName = state.config.propMapping.type || '種別';
    const foundTypeProp = props[typePropName] || Object.values(props).find(p => ['種別', 'タイプ', 'type'].includes(p.name.toLowerCase()));
    if (foundTypeProp) {
      if (foundTypeProp.type === 'select') {
        properties[foundTypeProp.name] = { select: { name: isItem ? '物品' : '場所' } };
      } else if (foundTypeProp.type === 'status') {
        properties[foundTypeProp.name] = { status: { name: isItem ? '物品' : '場所' } };
      }
    }

    // 4. 現在地 (Location) プロパティが存在する場合のみ設定（物品のみ）
    if (isItem && locationPageId) {
      let locPropName = state.config.propMapping.location || '現在地';
      const foundLoc = props[locPropName] || Object.values(props).find(p => p.type === 'relation');
      if (foundLoc && foundLoc.type === 'relation') {
        properties[foundLoc.name] = {
          relation: [{ id: locationPageId }]
        };
      }
    }

    const res = await this._request(`pages`, {
      method: 'POST',
      body: JSON.stringify({
        parent: { database_id: targetDbId },
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
      else if (idProp.type === 'unique_id') idVal = idProp.unique_id?.number;
      else if (idProp.type === 'rich_text') idVal = idProp.rich_text?.[0]?.plain_text;
      else if (idProp.type === 'title') idVal = idProp.title?.[0]?.plain_text;
    }

    if (idVal == null) {
      for (const [key, p] of Object.entries(props)) {
        if (key.toLowerCase() === 'id' || key === '管理番号' || key === '物品id' || key === '場所id') {
          if (p.type === 'number') idVal = p.number;
          else if (p.type === 'unique_id') idVal = p.unique_id?.number;
          else if (p.type === 'rich_text') idVal = p.rich_text?.[0]?.plain_text;
          break;
        }
      }
    }

    let titleVal = '';
    const titleProp = props[propMapping.title] || Object.values(props).find(p => p.type === 'title');
    if (titleProp && titleProp.title) {
      titleVal = titleProp.title.map(t => t.plain_text).join('');
    }

    let locationRelation = [];
    const locProp = props[propMapping.location]
      || Object.values(props).find(p => p.type === 'relation' && ['現在地', '場所', '保管場所', '収納先'].includes(p.name))
      || Object.values(props).find(p => p.type === 'relation');
    if (locProp && locProp.type === 'relation') {
      locationRelation = locProp.relation || [];
    }

    let statusVal = '';
    const statusProp = props[propMapping.status] || Object.values(props).find(p => p.type === 'status' || p.type === 'select');
    if (statusProp) {
      if (statusProp.type === 'status') statusVal = statusProp.status?.name || '';
      else if (statusProp.type === 'select') statusVal = statusProp.select?.name || '';
    }

    let notesVal = '';
    const notesProp = props[propMapping.notes] || Object.values(props).find(p => p.type === 'rich_text' && p !== props[propMapping.id]);
    if (notesProp && notesProp.type === 'rich_text') {
      notesVal = notesProp.rich_text.map(t => t.plain_text).join('');
    }

    return {
      pageId: page.id,
      id: idVal,
      name: titleVal || (idVal != null ? `ID: ${idVal}` : '名称未設定'),
      locationPageIds: locationRelation.map(r => r.id),
      status: statusVal,
      notes: notesVal,
      url: page.url,
      rawProperties: props
    };
  }
}

export const notion = new NotionClient();
