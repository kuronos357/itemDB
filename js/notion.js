/**
 * itemDB - Notion API Client
 * 
 * Notion API (v1) との通信、CORS回避プロキシのハンドリング、
 * データベースのクエリおよびページプロパティの更新を担当します。
 */

import { state } from './state.js';

export class NotionClient {
  constructor() {
    this.version = '2025-09-03';
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
   * データベースまたはデータソースのスキーマ（プロパティ定義一覧）を取得・キャッシュ
   */
  async getDatabaseSchema(targetId = null, forceRefresh = false) {
    const rawInput = targetId || state.config.itemDbId || state.config.dbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが未設定です。');
    const cleanId = NotionClient.extractDatabaseId(rawInput);

    if (!forceRefresh && this._schemaCache[cleanId]) {
      return this._schemaCache[cleanId];
    }

    let data = null;
    // 2025-09-03 では data_sources/{id} がスキーマエンドポイント
    try {
      data = await this._request(`data_sources/${cleanId}`, { method: 'GET' });
    } catch (e) {
      data = await this._request(`databases/${cleanId}`, { method: 'GET' });
    }

    // もし databases/{id} で data_sources 配列が返ってきた場合
    if (data?.data_sources && data.data_sources.length > 0) {
      const firstDsId = data.data_sources[0].id.replace(/-/g, '');
      try {
        const dsData = await this._request(`data_sources/${firstDsId}`, { method: 'GET' });
        const schema = {
          id: firstDsId,
          title: dsData.title?.[0]?.plain_text || dsData.name || data.title?.[0]?.plain_text || '名称未設定',
          properties: dsData.properties || {}
        };
        this._schemaCache[cleanId] = schema;
        this._schemaCache[firstDsId] = schema;
        return schema;
      } catch {}
    }

    const schema = {
      id: cleanId,
      title: data?.title?.[0]?.plain_text || data?.name || '名称未設定',
      properties: data?.properties || {}
    };
    this._schemaCache[cleanId] = schema;
    return schema;
  }

  /**
   * 単一のURL/ID入力から、Notion 2025-09-03 の複数データソースまたはリレーションを解析して物品DBと場所DBを自動判別
   */
  async resolveDatabases(inputRaw) {
    if (!inputRaw) throw new Error('データベースのURLまたはIDが入力されていません。');
    let targetId = NotionClient.extractDatabaseId(inputRaw);

    // 1. 指定されたDBの情報を取得
    let dbData = null;
    try {
      dbData = await this._request(`databases/${targetId}`, { method: 'GET' });
    } catch (err) {
      // A. targetId が data_source のIDである可能性をチェック (Notion 2025-09-03 API)
      try {
        const dsData = await this._request(`data_sources/${targetId}`, { method: 'GET' });
        if (dsData?.parent?.database_id) {
          const parentDbId = dsData.parent.database_id.replace(/-/g, '');
          try {
            dbData = await this._request(`databases/${parentDbId}`, { method: 'GET' });
            targetId = parentDbId;
          } catch {}
        }
        if (!dbData && dsData) {
          dbData = {
            id: targetId,
            title: dsData.title || [{ plain_text: dsData.name || 'データソース' }],
            properties: dsData.properties || {},
            data_sources: [dsData]
          };
        }
      } catch (dsErr) {
        // data_sources でもなかった場合はフォールバックへ
      }

      // B. 404の場合、URLに含まれる ?v= (ビューID) や親ページ側の子DBを探す
      if (!dbData && (err.status === 404 || err.message?.includes('404') || err.message?.includes('Could not find database'))) {
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
    const containerTitle = dbData.title?.[0]?.plain_text || 'データベース';

    let itemDbInfo = null;
    let locationDbInfo = null;

    // パターンA: 2025-09-03 の複数データソース (マルチデータソースDB)
    // 1つのデータベースコンテナに複数のデータソース（物品、場所など）が含まれている場合
    if (dbData.data_sources && dbData.data_sources.length >= 2) {
      const dsList = dbData.data_sources;
      let itemDs = null;
      let locDs = null;

      // 1. 各データソースのプロパティ構造による高精度判定
      for (const ds of dsList) {
        const cleanId = ds.id.replace(/-/g, '');
        try {
          const schema = await this.getDatabaseSchema(cleanId);
          const props = schema?.properties || {};
          // 親アイテム・サブアイテム（階層構造）を持つのは場所データソース
          if (props['親アイテム'] || props['サブアイテム']) {
            locDs = ds;
          }
          // 物理アドレスや現在地へのリレーションを持つのは物品データソース
          if (props['物理アドレス'] || props['現在地']) {
            itemDs = ds;
          }
        } catch {}
      }

      // 2. 名前による判定（目録/物品 vs 物理アドレス/場所）
      if (!itemDs || !locDs) {
        if (!itemDs) {
          // 「物理アドレス」に「物」が含まれるため「目録」や「物品」などを優先一致
          itemDs = dsList.find(ds => /^(目録|物品|アイテム|品名|ツール|tools?|items?|catalog)$/i.test(ds.name))
                || dsList.find(ds => /目録|アイテム|item|ツール|パーツ|品名/i.test(ds.name))
                || (locDs ? dsList.find(ds => ds.id !== locDs.id) : null);
        }
        if (!locDs) {
          locDs = dsList.find(ds => /^(物理アドレス|アドレス|場所|位置|ロケーション|棚|収納)$/i.test(ds.name))
               || dsList.find(ds => /物理アドレス|アドレス|場所|位置|収納|棚|部屋|ボックス|box|保管/i.test(ds.name))
               || (itemDs ? dsList.find(ds => ds.id !== itemDs.id) : null);
        }
      }

      // 3. フォールバック
      if (!itemDs && !locDs) {
        itemDs = dsList[0];
        locDs = dsList[1];
      } else if (!itemDs) {
        itemDs = dsList.find(ds => ds.id !== locDs.id) || dsList[0];
      } else if (!locDs) {
        locDs = dsList.find(ds => ds.id !== itemDs.id) || dsList[1];
      }

      const cleanItemDsId = itemDs.id.replace(/-/g, '');
      const cleanLocDsId = locDs.id.replace(/-/g, '');

      // 各データソースのスキーマを取得
      await this.getDatabaseSchema(cleanItemDsId).catch(() => {});
      await this.getDatabaseSchema(cleanLocDsId).catch(() => {});

      itemDbInfo = { id: cleanItemDsId, title: itemDs.name || '物品' };
      locationDbInfo = { id: cleanLocDsId, title: locDs.name || '場所' };
    }
    // パターンB: データソースが1つの場合、またはリレーションで別DBと接続している場合
    else {
      let firstDsId = cleanTargetId;
      let primaryProps = dbData.properties;

      if (dbData.data_sources && dbData.data_sources.length === 1) {
        firstDsId = dbData.data_sources[0].id.replace(/-/g, '');
        try {
          const dsSchema = await this.getDatabaseSchema(firstDsId);
          primaryProps = dsSchema.properties;
        } catch {}
      }

      if (!primaryProps) {
        try {
          const schema = await this.getDatabaseSchema(firstDsId);
          primaryProps = schema.properties;
        } catch {}
      }

      const props = primaryProps || {};
      const relationProps = Object.values(props).filter(p => p.type === 'relation' && (p.relation?.database_id || p.relation?.data_source_id));

      if (relationProps.length > 0) {
        const relProp = relationProps.find(p => ['現在地', '場所', '保管場所', '収納先'].includes(p.name))
          || relationProps.find(p => ['収容物', '物品', 'アイテム'].includes(p.name))
          || relationProps[0];

        const relatedId = (relProp.relation.data_source_id || relProp.relation.database_id).replace(/-/g, '');
        let titleB = '関連データベース';
        try {
          const relatedSchema = await this.getDatabaseSchema(relatedId);
          titleB = relatedSchema.title || titleB;
        } catch {}

        const lowerA = containerTitle.toLowerCase();
        const isAItem = /物|アイテム|item|ツール|tool|パーツ|part/.test(lowerA) ||
                        ['現在地', '場所', '保管場所', '収納先'].includes(relProp.name);
        const isALocation = /場|ロケーション|location|収納|棚|部屋|ボックス|box/.test(lowerA) ||
                            ['収容物', '物品', 'アイテム'].includes(relProp.name);

        if (isAItem && !isALocation) {
          itemDbInfo = { id: firstDsId, title: containerTitle };
          locationDbInfo = { id: relatedId, title: titleB };
        } else if (isALocation && !isAItem) {
          locationDbInfo = { id: firstDsId, title: containerTitle };
          itemDbInfo = { id: relatedId, title: titleB };
        } else {
          itemDbInfo = { id: firstDsId, title: containerTitle };
          locationDbInfo = { id: relatedId, title: titleB };
        }
      } else {
        itemDbInfo = { id: firstDsId, title: containerTitle };
        locationDbInfo = { id: firstDsId, title: containerTitle };
      }
    }

    // スキーマからプロパティのマッピングを自動検出・更新
    const detectedMapping = { ...(state.config.propMapping || {}) };
    try {
      const itemSchema = await this.getDatabaseSchema(itemDbInfo.id);
      const props = itemSchema?.properties || {};

      // 1. タイトルプロパティ（物品名、名前など）
      const foundTitle = Object.values(props).find(p => p.type === 'title');
      if (foundTitle) detectedMapping.title = foundTitle.name;

      // 2. IDプロパティ（数値、unique_id、または名前にID/番号を含むプロパティ）
      const foundId = Object.values(props).find(p => ['id', '物品id', '場所id', '管理番号', 'no', 'コード'].includes(p.name.toLowerCase()))
                   || Object.values(props).find(p => p.type === 'number' || p.type === 'unique_id');
      if (foundId) detectedMapping.id = foundId.name;

      // 3. リレーション（場所へのリンク）
      const foundLocRel = Object.values(props).find(p => p.type === 'relation' && (
        p.relation?.data_source_id?.replace(/-/g, '') === locationDbInfo.id ||
        p.relation?.database_id?.replace(/-/g, '') === locationDbInfo.id ||
        ['現在地', '場所', '保管場所', '収納先', '配置場所', '配置先'].includes(p.name)
      )) || Object.values(props).find(p => p.type === 'relation');
      if (foundLocRel) detectedMapping.location = foundLocRel.name;

      // 4. 状態プロパティ
      const foundStatus = Object.values(props).find(p => ['状態', 'ステータス', 'status'].includes(p.name.toLowerCase()) && (p.type === 'status' || p.type === 'select'))
                       || Object.values(props).find(p => p.type === 'status');
      if (foundStatus) detectedMapping.status = foundStatus.name;

      // 5. メモプロパティ
      const foundNotes = Object.values(props).find(p => ['メモ', '備考', '説明', '詳細'].includes(p.name) && p.type === 'rich_text')
                      || Object.values(props).find(p => p.type === 'rich_text' && p.name !== detectedMapping.id);
      if (foundNotes) detectedMapping.notes = foundNotes.name;
    } catch (e) {
      console.warn('[NotionClient] プロパティ自動解析スキップ:', e);
    }

    // stateに保存
    state.saveConfig({
      dbId: cleanTargetId,
      itemDbId: itemDbInfo.id,
      locationDbId: locationDbInfo.id,
      itemDbTitle: itemDbInfo.title,
      locationDbTitle: locationDbInfo.title,
      propMapping: detectedMapping
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
    const itemDbId = state.config.itemDbId;
    const locationDbId = state.config.locationDbId;
    const rawInput = state.config.dbId || itemDbId || locationDbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが設定されていません。');

    // すでに物品DBと場所DB（データソースID）の両方が設定されている場合は直接両方のスキーマを取得して確認
    if (itemDbId && locationDbId && itemDbId !== locationDbId) {
      try {
        const itemSchema = await this.getDatabaseSchema(itemDbId);
        const locSchema = await this.getDatabaseSchema(locationDbId);
        return {
          itemDb: { id: itemDbId, title: itemSchema.title || '物品' },
          locationDb: { id: locationDbId, title: locSchema.title || '場所' },
          isDual: true
        };
      } catch (err) {
        console.warn('[NotionClient] Direct schema check failed, falling back to resolveDatabases:', err);
      }
    }

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
   * 指定DB/データソースに対して型安全な単一ID検索を実行
   */
  async _queryDbForId(cleanTargetId, numericId) {
    const idNum = Number(numericId);
    const idStr = String(numericId);

    let schema = null;
    try {
      schema = await this.getDatabaseSchema(cleanTargetId);
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

    const executeQuery = async (filter) => {
      try {
        return await this._request(`data_sources/${cleanTargetId}/query`, {
          method: 'POST',
          body: JSON.stringify({ filter, page_size: 1 })
        });
      } catch (err) {
        if (err.status === 404 || err.message?.includes('404')) {
          return await this._request(`databases/${cleanTargetId}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter, page_size: 1 })
          });
        }
        throw err;
      }
    };

    let res = null;
    try {
      res = await executeQuery(queryFilter);
    } catch (err) {
      const match = err.message && err.message.match(/property (\w+) does not match filter (\w+)/i);
      if (match) {
        const correctType = match[1].toLowerCase();
        console.warn(`[NotionClient] プロパティ型を自動補正して再試行: ${propType} -> ${correctType}`);
        const fixedFilter = buildFilter(actualPropName, correctType);
        res = await executeQuery(fixedFilter);
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
        const titleRes = await executeQuery({ property: titleProp.name, title: { equals: idStr } });
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
   * 指定した場所 (pageId) に現在置かれている物品一覧を取得 (物品DB/データソースをクエリ)
   */
  async queryItemsByLocation(locationPageId) {
    if (!state.config.itemDbId || !state.config.locationDbId) {
      if (state.config.dbId) await this.resolveDatabases(state.config.dbId).catch(() => {});
    }

    const itemTargetId = state.config.itemDbId || state.config.dbId;
    if (!itemTargetId) return [];

    let locPropName = state.config.propMapping.location || '物理アドレス';
    try {
      const schema = await this.getDatabaseSchema(itemTargetId);
      const props = schema?.properties || {};
      if (!props[locPropName] || props[locPropName].type !== 'relation') {
        const foundRel = props['物理アドレス']
          || props['現在地']
          || Object.values(props).find(p => p.type === 'relation' && (
               p.relation?.data_source_id?.replace(/-/g, '') === state.config.locationDbId ||
               p.relation?.database_id?.replace(/-/g, '') === state.config.locationDbId
             ))
          || Object.values(props).find(p => p.type === 'relation');
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

    let res = null;
    try {
      res = await this._request(`data_sources/${itemTargetId}/query`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    } catch (e) {
      res = await this._request(`databases/${itemTargetId}/query`, {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }

    return (res?.results || []).map(page => this._normalizeRecord(page));
  }

  /**
   * 指定した場所レコードに所属する物品一覧を完全取得
   * (場所自体の「目録」リレーションと、物品DBへの「物理アドレス」検索クエリの両面から確実に集約)
   */
  async getItemsForLocation(locationRecord) {
    if (!locationRecord || !locationRecord.pageId) return [];

    const itemsMap = new Map();

    // 1. 物品DBへの逆引きクエリ (queryItemsByLocation)
    try {
      const queriedItems = await this.queryItemsByLocation(locationRecord.pageId);
      for (const item of queriedItems) {
        if (item && item.pageId) {
          itemsMap.set(item.pageId, item);
        }
      }
    } catch (e) {
      console.warn('[NotionClient] queryItemsByLocation failed, fallback to direct relation:', e);
    }

    // 2. 場所レコード自体が持つ itemPageIds (目録リレーション) の直接取得
    const directIds = locationRecord.itemPageIds || [];
    const missingIds = directIds.filter(id => !itemsMap.has(id));

    if (missingIds.length > 0) {
      try {
        const fetchedList = await Promise.all(
          missingIds.map(id => this.fetchPage(id).catch(err => {
            console.warn(`[NotionClient] fetchPage failed for item ${id}:`, err);
            return null;
          }))
        );
        for (const item of fetchedList) {
          if (item && item.pageId) {
            itemsMap.set(item.pageId, item);
          }
        }
      } catch (e) {
        console.warn('[NotionClient] Fetching direct itemPageIds failed:', e);
      }
    }

    // ID順または名前順にソートして返却
    return Array.from(itemsMap.values()).sort((a, b) => {
      if (a.id != null && b.id != null) return Number(a.id) - Number(b.id);
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  /**
   * サブ場所（下位階層: 段・引き出し・ボックス等）のレコード一覧を取得
   */
  async getSubLocations(locationRecord) {
    if (!locationRecord || !locationRecord.subLocationPageIds || locationRecord.subLocationPageIds.length === 0) {
      return [];
    }

    try {
      const subPages = await Promise.all(
        locationRecord.subLocationPageIds.map(id => this.fetchPage(id).catch(() => null))
      );
      return subPages.filter(Boolean).sort((a, b) => {
        if (a.id != null && b.id != null) return Number(a.id) - Number(b.id);
        return (a.name || '').localeCompare(b.name || '');
      });
    } catch (e) {
      console.warn('[NotionClient] getSubLocations failed:', e);
      return [];
    }
  }

  /**
   * 親場所（上位階層: 部屋・カラーボックス等）のレコードを取得
   */
  async getParentLocation(locationRecord) {
    if (!locationRecord || !locationRecord.parentLocationPageIds || locationRecord.parentLocationPageIds.length === 0) {
      return null;
    }

    try {
      return await this.fetchPage(locationRecord.parentLocationPageIds[0]);
    } catch (e) {
      console.warn('[NotionClient] getParentLocation failed:', e);
      return null;
    }
  }

  /**
   * 物品の現在地（リレーション）を更新 (物品ページのプロパティをPATCH)
   */
  async updateItemLocation(itemPageId, locationPageId) {
    if (!state.config.itemDbId || !state.config.locationDbId) {
      if (state.config.dbId) await this.resolveDatabases(state.config.dbId).catch(() => {});
    }

    const itemTargetId = state.config.itemDbId || state.config.dbId;
    let locPropName = state.config.propMapping.location || '物理アドレス';
    try {
      const schema = await this.getDatabaseSchema(itemTargetId);
      const props = schema?.properties || {};
      if (!props[locPropName] || props[locPropName].type !== 'relation') {
        const foundRel = props['物理アドレス']
          || props['現在地']
          || Object.values(props).find(p => p.type === 'relation' && (
               p.relation?.data_source_id?.replace(/-/g, '') === state.config.locationDbId ||
               p.relation?.database_id?.replace(/-/g, '') === state.config.locationDbId
             ))
          || Object.values(props).find(p => p.type === 'relation');
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
   * 新しい物品または場所レコードを作成 (data_source_id / database_id 両対応)
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

    // 4. 現在地/物理アドレス プロパティが存在する場合のみ設定（物品のみ）
    if (isItem && locationPageId) {
      let locPropName = state.config.propMapping.location || '物理アドレス';
      const foundLoc = props[locPropName]
        || props['物理アドレス']
        || Object.values(props).find(p => p.type === 'relation' && (
             p.relation?.data_source_id?.replace(/-/g, '') === state.config.locationDbId ||
             p.relation?.database_id?.replace(/-/g, '') === state.config.locationDbId ||
             ['物理アドレス', '現在地', '場所', '保管場所', '収納先'].includes(p.name)
           ))
        || Object.values(props).find(p => p.type === 'relation');

      if (foundLoc && foundLoc.type === 'relation') {
        properties[foundLoc.name] = {
          relation: [{ id: locationPageId }]
        };
      }
    }

    // 5. アクティブ (checkbox) が存在する場合は true に設定（物品のみ）
    if (isItem && props['アクティブ']?.type === 'checkbox') {
      properties['アクティブ'] = { checkbox: true };
    }

    // 2025-09-03 では data_source_id または database_id で親を指定
    let res = null;
    try {
      res = await this._request(`pages`, {
        method: 'POST',
        body: JSON.stringify({
          parent: { data_source_id: targetDbId },
          properties
        })
      });
    } catch (err) {
      if (err.status === 400 || err.status === 404 || err.message?.includes('data_source_id')) {
        res = await this._request(`pages`, {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: targetDbId },
            properties
          })
        });
      } else {
        throw err;
      }
    }

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
      else if (idProp.type === 'formula') idVal = idProp.formula?.number != null ? idProp.formula.number : idProp.formula?.string;
      else if (idProp.type === 'unique_id') idVal = idProp.unique_id?.number;
      else if (idProp.type === 'rich_text') idVal = idProp.rich_text?.[0]?.plain_text;
      else if (idProp.type === 'title') idVal = idProp.title?.[0]?.plain_text;
    }

    if (idVal == null) {
      for (const [key, p] of Object.entries(props)) {
        if (key.toLowerCase() === 'id' || key === '管理番号' || key === '物品id' || key === '場所id' || key === 'no' || key === 'コード') {
          if (p.type === 'number') idVal = p.number;
          else if (p.type === 'formula') idVal = p.formula?.number != null ? p.formula.number : p.formula?.string;
          else if (p.type === 'unique_id') idVal = p.unique_id?.number;
          else if (p.type === 'rich_text') idVal = p.rich_text?.[0]?.plain_text;
          break;
        }
      }
    }

    // どのキーにも一致しない場合、任意のnumber型プロパティをID候補とする
    if (idVal == null) {
      const anyNum = Object.values(props).find(p => p.type === 'number' || p.type === 'unique_id');
      if (anyNum) {
        idVal = anyNum.type === 'number' ? anyNum.number : anyNum.unique_id?.number;
      }
    }

    let titleVal = '';
    const titleProp = props[propMapping.title] || Object.values(props).find(p => p.type === 'title');
    if (titleProp && titleProp.title) {
      titleVal = titleProp.title.map(t => t.plain_text).join('');
    }

    // タイトルが数字のみでIDが未特定の場合、タイトルをIDとして解釈
    if (idVal == null && /^\d+$/.test(titleVal.trim())) {
      idVal = Number(titleVal.trim());
    }

    // リレーションの正確な種別判定（物品側・場所側・階層を分離）
    const itemProp = props['目録']
      || props['物品']
      || props['アイテム']
      || props['収容物'];
    const itemPageIds = (itemProp?.type === 'relation' && itemProp.relation)
      ? itemProp.relation.map(r => r.id)
      : [];

    const parentProp = props['親アイテム'] || props['親'] || props['上位'];
    const parentLocationPageIds = (parentProp?.type === 'relation' && parentProp.relation)
      ? parentProp.relation.map(r => r.id)
      : [];

    const subProp = props['サブアイテム'] || props['子'] || props['下位'];
    const subLocationPageIds = (subProp?.type === 'relation' && subProp.relation)
      ? subProp.relation.map(r => r.id)
      : [];

    // 物品側から見た場所へのリレーション
    let locationRelation = [];
    const locProp = props[propMapping.location]
      || props['物理アドレス']
      || props['現在地']
      || props['場所']
      || props['保管場所']
      || props['収納先'];
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

    // 属性 (multi_select) の抽出
    const attrProp = props['属性'] || Object.values(props).find(p => p.type === 'multi_select');
    const attributes = attrProp?.multi_select ? attrProp.multi_select.map(opt => opt.name) : [];

    // アクティブフラグ (checkbox)
    const activeProp = props['アクティブ'];
    const isActive = activeProp?.type === 'checkbox' ? activeProp.checkbox : null;

    if (!statusVal && isActive !== null) {
      statusVal = isActive ? 'アクティブ' : '非アクティブ';
    }

    if (!notesVal && attributes.length > 0) {
      notesVal = attributes.join(' / ');
    }

    return {
      pageId: page.id,
      id: idVal,
      name: titleVal || (idVal != null ? `ID: ${idVal}` : '名称未設定'),
      locationPageIds: locationRelation.map(r => r.id),
      itemPageIds,
      parentLocationPageIds,
      subLocationPageIds,
      status: statusVal,
      notes: notesVal,
      attributes,
      isActive,
      url: page.url,
      rawProperties: props
    };
  }
}

export const notion = new NotionClient();
