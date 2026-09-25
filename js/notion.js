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
   * 32桁の16進数文字列を標準のUUID形式 (8-4-4-4-12) に変換
   */
  static formatUuid(input) {
    if (!input) return '';
    const clean = String(input).replace(/-/g, '').trim();
    if (clean.length !== 32) return input;
    return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
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

    // デフォルト: Cloudflare Pages Functions (/api/...)
    return `/api/${cleanEndpoint}`;
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
        err.data = data;
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
    let configDbInfo = null;

    // パターンA: 2025-09-03 の複数データソース (マルチデータソースDB)
    // 1つのデータベースコンテナに複数のデータソース（物品、場所、設定など）が含まれている場合
    if (dbData.data_sources && dbData.data_sources.length >= 2) {
      const dsList = dbData.data_sources;
      let itemDs = null;
      let locDs = null;
      let configDs = null;

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
          // 「サービス名」や「設定」を持つ、または設定/config/api/セットアップを含むのは設定データソース
          if ((props['サービス名'] && props['設定']) || /設定|セットアップ|setup|config|settings|env|api/i.test(ds.name)) {
            configDs = ds;
          }
        } catch {}
      }

      // 2. 名前による判定（目録/物品 vs 物理アドレス/場所 vs 設定）
      if (!itemDs || !locDs || !configDs) {
        if (!itemDs) {
          itemDs = dsList.find(ds => /^(目録|物品|アイテム|品名|ツール|tools?|items?|catalog)$/i.test(ds.name))
                || dsList.find(ds => /目録|アイテム|item|ツール|パーツ|品名/i.test(ds.name))
                || (locDs ? dsList.find(ds => ds.id !== locDs.id && ds.id !== configDs?.id) : null);
        }
        if (!locDs) {
          locDs = dsList.find(ds => /^(物理アドレス|アドレス|場所|位置|ロケーション|棚|収納)$/i.test(ds.name))
               || dsList.find(ds => /物理アドレス|アドレス|場所|位置|収納|棚|部屋|ボックス|box|保管/i.test(ds.name))
               || (itemDs ? dsList.find(ds => ds.id !== itemDs.id && ds.id !== configDs?.id) : null);
        }
        if (!configDs) {
          configDs = dsList.find(ds => /設定|セットアップ|setup|config|settings|api|環境変数/i.test(ds.name))
                  || (itemDs && locDs ? dsList.find(ds => ds.id !== itemDs.id && ds.id !== locDs.id) : null);
        }
      }

      // 3. フォールバック
      if (!itemDs && !locDs) {
        itemDs = dsList[0];
        locDs = dsList[1];
        if (dsList.length > 2) configDs = dsList[2];
      } else if (!itemDs) {
        itemDs = dsList.find(ds => ds.id !== locDs.id && ds.id !== configDs?.id) || dsList[0];
      } else if (!locDs) {
        locDs = dsList.find(ds => ds.id !== itemDs.id && ds.id !== configDs?.id) || dsList[1];
      }

      const cleanItemDsId = itemDs.id.replace(/-/g, '');
      const cleanLocDsId = locDs.id.replace(/-/g, '');
      const cleanConfigDsId = configDs ? configDs.id.replace(/-/g, '') : null;

      // 各データソースのスキーマを取得
      await this.getDatabaseSchema(cleanItemDsId).catch(() => {});
      await this.getDatabaseSchema(cleanLocDsId).catch(() => {});
      if (cleanConfigDsId) {
        await this.getDatabaseSchema(cleanConfigDsId).catch(() => {});
      }

      itemDbInfo = { id: cleanItemDsId, title: itemDs.name || '物品' };
      locationDbInfo = { id: cleanLocDsId, title: locDs.name || '場所' };
      if (configDs && cleanConfigDsId) {
        configDbInfo = { id: cleanConfigDsId, title: configDs.name || '設定' };
      }
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
    const configUpdates = {
      dbId: cleanTargetId,
      itemDbId: itemDbInfo.id,
      locationDbId: locationDbInfo.id,
      itemDbTitle: itemDbInfo.title,
      locationDbTitle: locationDbInfo.title,
      propMapping: detectedMapping
    };
    if (configDbInfo) {
      configUpdates.configDbId = configDbInfo.id;
      configUpdates.configDbTitle = configDbInfo.title;
    }
    state.saveConfig(configUpdates);

    return {
      itemDb: itemDbInfo,
      locationDb: locationDbInfo,
      configDb: configDbInfo,
      isDual: itemDbInfo.id !== locationDbInfo.id
    };
  }

  /**
   * データベース疎通テスト（2つのDBおよび設定DBの連携状況を診断）
   */
  async testConnection() {
    const itemDbId = state.config.itemDbId;
    const locationDbId = state.config.locationDbId;
    const configDbId = state.config.configDbId;
    const rawInput = state.config.dbId || itemDbId || locationDbId;
    if (!rawInput) throw new Error('データベースのURLまたはIDが設定されていません。');

    // すでに物品DBと場所DB（データソースID）の両方が設定されている場合は直接スキーマを取得して確認
    if (itemDbId && locationDbId && itemDbId !== locationDbId) {
      try {
        const itemSchema = await this.getDatabaseSchema(itemDbId);
        const locSchema = await this.getDatabaseSchema(locationDbId);
        let configDbResult = null;
        if (configDbId) {
          try {
            const cfgSchema = await this.getDatabaseSchema(configDbId);
            configDbResult = { id: configDbId, title: cfgSchema.title || '設定' };
          } catch {}
        }
        return {
          itemDb: { id: itemDbId, title: itemSchema.title || '物品' },
          locationDb: { id: locationDbId, title: locSchema.title || '場所' },
          configDb: configDbResult,
          isDual: true
        };
      } catch (err) {
        console.warn('[NotionClient] Direct schema check failed, falling back to resolveDatabases:', err);
      }
    }

    return await this.resolveDatabases(rawInput);
  }

  /**
   * Notionの設定データソース（または設定DB）からAPIキー等の設定を読み込み
   * @param {string} [customConfigDbId]
   * @returns {Promise<{ count: number, updatedKeys: string[], config: object }>}
   */
  async loadConfigFromNotion(customConfigDbId = null) {
    let targetConfigId = customConfigDbId || state.config.configDbId;

    // 設定DB IDが未設定の場合、親DBから自動解決
    if (!targetConfigId && (state.config.dbId || state.config.itemDbId)) {
      try {
        const resolved = await this.resolveDatabases(state.config.dbId || state.config.itemDbId);
        targetConfigId = resolved.configDb?.id || state.config.configDbId;
      } catch (e) {
        console.warn('[NotionClient] resolveDatabases failed during config load:', e);
      }
    }

    if (!targetConfigId) {
      throw new Error('設定用データベースが見つかりません。Notionの親データベースURLを入力してください。');
    }

    const cleanId = NotionClient.extractDatabaseId(targetConfigId);

    // クエリ実行 (全件取得)
    let res = null;
    try {
      res = await this._request(`data_sources/${cleanId}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 100 })
      });
    } catch (err) {
      if (err.status === 404 || err.message?.includes('404')) {
        res = await this._request(`databases/${cleanId}/query`, {
          method: 'POST',
          body: JSON.stringify({ page_size: 100 })
        });
      } else {
        throw err;
      }
    }

    const pages = res?.results || [];
    if (pages.length === 0) {
      return { count: 0, updatedKeys: [], config: {} };
    }

    const updates = {};
    const updatedKeys = [];

    for (const page of pages) {
      const props = page.properties || {};

      // タイトル（サービス名）の取得
      let title = '';
      for (const p of Object.values(props)) {
        if (p.type === 'title') {
          title = p.title?.map(t => t.plain_text).join('').trim() || '';
          break;
        }
      }

      // 設定値の取得 (rich_text, url, number, etc.)
      let value = '';
      const configProp = props['設定'] || Object.values(props).find(p => p.type === 'rich_text' || p.type === 'url');
      if (configProp) {
        if (configProp.type === 'rich_text') {
          value = configProp.rich_text?.map(t => t.plain_text).join('').trim() || '';
        } else if (configProp.type === 'url') {
          value = configProp.url || '';
        } else if (configProp.type === 'number') {
          value = configProp.number != null ? String(configProp.number) : '';
        }
      }

      if (!title || !value) continue;

      const normTitle = title.toLowerCase().replace(/[\s\-_（）\(\)]/g, '');

      if (normTitle.includes('notion') || normTitle.includes('トークン') || normTitle.includes('secret')) {
        // Notion APIトークンはセキュリティおよび設計上、Notionテーブルから同期しない（端末内のみで安全に管理）
      } else if (normTitle.includes('物品db') || normTitle.includes('itemdb') || (normTitle.includes('物品') && (value.includes('notion.so') || /^[0-9a-f\-]{32,36}$/i.test(value)))) {
        const extracted = NotionClient.extractDatabaseId(value);
        if (extracted && /^[0-9a-f]{32}$/i.test(extracted)) {
          updates.itemDbId = extracted;
          updatedKeys.push('物品DB ID');
        }
      } else if (normTitle.includes('場所db') || normTitle.includes('locationdb') || (normTitle.includes('場所') && (value.includes('notion.so') || /^[0-9a-f\-]{32,36}$/i.test(value)))) {
        const extracted = NotionClient.extractDatabaseId(value);
        if (extracted && /^[0-9a-f]{32}$/i.test(extracted)) {
          updates.locationDbId = extracted;
          updatedKeys.push('場所DB ID');
        }
      } else if (normTitle.includes('yahoo') || normTitle.includes('appid') || normTitle.includes('ヤフー') || normTitle.includes('client') || normTitle.includes('クライアント')) {
        updates.yahooAppId = value;
        updatedKeys.push('Yahoo Client ID');
      } else if (normTitle.includes('jev最大') || normTitle.includes('jevmax') || normTitle.includes('最大件数')) {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n > 0) {
          updates.jevMaxAttributes = n;
          updatedKeys.push('Jev最大件数');
        }
      } else if (normTitle.includes('jev')) {
        updates.jevApiKey = value;
        updatedKeys.push('Jev APIキー');
      } else if (normTitle.includes('geminiモデル') || normTitle.includes('geminimodel') || normTitle.includes('モデル名')) {
        updates.geminiModel = value;
        updatedKeys.push(`Geminiモデル (${value})`);
      } else if (normTitle.includes('gemini') || normTitle.includes('ジェミニ')) {
        updates.geminiApiKey = value;
        updatedKeys.push('Gemini APIキー');
      }
    }

    if (Object.keys(updates).length > 0) {
      state.saveConfig(updates);
    }

    return {
      count: updatedKeys.length,
      updatedKeys,
      config: updates
    };
  }

  /**
   * 現在の設定をNotionの設定テーブルに書き込み・同期
   * @param {object} configData
   * @param {string} [customConfigDbId]
   */
  async saveConfigToNotion(configData, customConfigDbId = null) {
    let targetConfigId = customConfigDbId || state.config.configDbId;

    if (!targetConfigId && (state.config.dbId || state.config.itemDbId)) {
      try {
        const resolved = await this.resolveDatabases(state.config.dbId || state.config.itemDbId);
        targetConfigId = resolved.configDb?.id || state.config.configDbId;
      } catch (e) {
        console.warn('[NotionClient] resolveDatabases failed during config save:', e);
      }
    }

    if (!targetConfigId) {
      throw new Error('設定用データベースが見つかりません。');
    }

    const cleanId = NotionClient.extractDatabaseId(targetConfigId);

    // 既存ページをクエリ
    let res = null;
    try {
      res = await this._request(`data_sources/${cleanId}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 100 })
      });
    } catch (err) {
      if (err.status === 404 || err.message?.includes('404')) {
        res = await this._request(`databases/${cleanId}/query`, {
          method: 'POST',
          body: JSON.stringify({ page_size: 100 })
        });
      } else {
        throw err;
      }
    }

    const existingPages = res?.results || [];

    // Notion APIトークンはNotionテーブルに書き込まない（セキュリティおよび自己完結防止のため端末保持のみ）
    const itemMap = [
      { key: 'itemDbId', title: '物品DBID', val: configData.itemDbId },
      { key: 'locationDbId', title: '場所DBID', val: configData.locationDbId },
      { key: 'yahooAppId', title: 'Yahoo商品検索（v3）API', val: configData.yahooAppId },
      { key: 'jevApiKey', title: 'JevAPI', val: configData.jevApiKey },
      { key: 'jevMaxAttributes', title: 'Jev最大件数', val: configData.jevMaxAttributes != null ? String(configData.jevMaxAttributes) : '3' },
      { key: 'geminiApiKey', title: 'GeminiAPI', val: configData.geminiApiKey },
      { key: 'geminiModel', title: 'Geminiモデル名', val: configData.geminiModel || 'gemini-3.1-flash-lite' }
    ];

    let savedCount = 0;

    for (const item of itemMap) {
      if (item.val === undefined || item.val === null) continue;

      const normKey = item.title.toLowerCase().replace(/[\s\-_（）\(\)]/g, '');
      const matchedPage = existingPages.find(p => {
        const titleProp = Object.values(p.properties || {}).find(prop => prop.type === 'title');
        const t = titleProp?.title?.map(x => x.plain_text).join('').trim() || '';
        const normT = t.toLowerCase().replace(/[\s\-_（）\(\)]/g, '');
        return normT.includes(normKey) || normKey.includes(normT);
      });

      if (matchedPage) {
        await this._request(`pages/${matchedPage.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            properties: {
              '設定': {
                rich_text: [{ text: { content: String(item.val) } }]
              }
            }
          })
        });
        savedCount++;
      } else {
        await this._request(`pages`, {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: cleanId },
            properties: {
              'サービス名': {
                title: [{ text: { content: item.title } }]
              },
              '設定': {
                rich_text: [{ text: { content: String(item.val) } }]
              }
            }
          })
        });
        savedCount++;
      }
    }

    return savedCount;
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
   * バーコード（JAN/ISBNコード）に一致する既存レコードを検索
   * 「詳細」「メモ」「名前」等に含まれるかを検索します
   */
  async findRecordByBarcode(code) {
    const cleanCode = String(code).replace(/[-\s]/g, '').trim();
    if (!cleanCode) return null;

    const targetDbId = state.config.itemDbId || state.config.dbId;
    if (!targetDbId) return null;

    let schema = null;
    try {
      schema = await this.getDatabaseSchema(targetDbId);
    } catch {}
    const props = schema?.properties || {};

    const filterOrs = [];

    // 1. 詳細プロパティ (rich_text)
    const detailsProp = props['詳細'] || Object.values(props).find(p => p.type === 'rich_text' && p.name === '詳細');
    if (detailsProp) {
      filterOrs.push({
        property: detailsProp.name,
        rich_text: { contains: cleanCode }
      });
    }

    // 2. メモ・備考プロパティ (rich_text)
    const notesProp = props[state.config.propMapping.notes] || props['メモ'] || props['備考'];
    if (notesProp && notesProp.name !== detailsProp?.name && notesProp.type === 'rich_text') {
      filterOrs.push({
        property: notesProp.name,
        rich_text: { contains: cleanCode }
      });
    }

    // 3. タイトルプロパティ
    const titleProp = props[state.config.propMapping.title] || Object.values(props).find(p => p.type === 'title');
    if (titleProp) {
      filterOrs.push({
        property: titleProp.name,
        title: { contains: cleanCode }
      });
    }

    if (filterOrs.length === 0) return null;

    const filter = filterOrs.length === 1 ? filterOrs[0] : { or: filterOrs };

    const executeQuery = async () => {
      try {
        return await this._request(`data_sources/${targetDbId}/query`, {
          method: 'POST',
          body: JSON.stringify({ filter, page_size: 1 })
        });
      } catch (err) {
        if (err.status === 404 || err.message?.includes('404')) {
          return await this._request(`databases/${targetDbId}/query`, {
            method: 'POST',
            body: JSON.stringify({ filter, page_size: 1 })
          });
        }
        throw err;
      }
    };

    try {
      const res = await executeQuery();
      if (res?.results && res.results.length > 0) {
        return this._normalizeRecord(res.results[0]);
      }
    } catch (e) {
      console.warn('[NotionClient] findRecordByBarcode query error:', e);
    }

    return null;
  }

  /**
   * データベースの「属性」マルチセレクト選択肢一覧を取得（Jev AI分類の候補選択肢等に活用）
   */
  async getAttributeOptions(targetDbId = null) {
    const id = targetDbId || state.config.itemDbId || state.config.dbId;
    if (!id) return [];
    try {
      const schema = await this.getDatabaseSchema(id);
      const props = schema?.properties || {};
      const attrProp = props['属性'] || Object.values(props).find(p => p.type === 'multi_select');
      if (attrProp?.multi_select?.options) {
        return attrProp.multi_select.options.map(opt => opt.name);
      }
    } catch (e) {
      console.warn('[NotionClient] Failed to fetch attribute options:', e);
    }
    return [];
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
   * ページプロパティの中から「アクティブ/非アクティブ」を制御するプロパティを検出
   * @param {Object} props page.properties
   * @returns {{ name: string, type: string, prop: Object } | null}
   */
  _detectActiveProperty(props) {
    if (!props || typeof props !== 'object') return null;

    // 1. 完全一致キー
    const directKeys = ['アクティブ', 'Active', 'active', '有効'];
    for (const key of directKeys) {
      if (props[key]) {
        return { name: key, type: props[key].type, prop: props[key] };
      }
    }

    // 2. checkbox 型（名前に「アクティブ」「active」「有効」を含むもの優先）
    for (const [key, p] of Object.entries(props)) {
      if (p.type === 'checkbox') {
        const lower = key.toLowerCase();
        if (key.includes('アクティブ') || lower.includes('active') || key.includes('有効')) {
          return { name: key, type: 'checkbox', prop: p };
        }
      }
    }

    // 3. 任意の checkbox 型
    for (const [key, p] of Object.entries(props)) {
      if (p.type === 'checkbox') {
        return { name: key, type: 'checkbox', prop: p };
      }
    }

    // 4. status または select 型（名前に「状態」「ステータス」「status」「アクティブ」等を含むもの）
    for (const [key, p] of Object.entries(props)) {
      if (p.type === 'status' || p.type === 'select') {
        const lower = key.toLowerCase();
        if (key.includes('アクティブ') || lower.includes('active') || key.includes('状態') || key.includes('ステータス') || lower.includes('status')) {
          return { name: key, type: p.type, prop: p };
        }
      }
    }

    return null;
  }

  /**
   * 物品または場所のアクティブ／非アクティブ状態を更新 (PATCH)
   * @param {string} pageId 対象のNotionページID
   * @param {boolean} nextActive 新しいアクティブ状態 (true: アクティブ, false: 非アクティブ)
   * @param {Object} [rawProperties] 既存のプロパティ情報
   */
  async updateActiveStatus(pageId, nextActive, rawProperties = null) {
    let props = rawProperties;
    if (!props) {
      const page = await this.fetchPage(pageId);
      props = page?.rawProperties || {};
    }

    const detected = this._detectActiveProperty(props);
    const properties = {};

    if (detected) {
      const { name, type } = detected;
      if (type === 'checkbox') {
        properties[name] = { checkbox: Boolean(nextActive) };
      } else if (type === 'status') {
        properties[name] = { status: { name: nextActive ? 'アクティブ' : '非アクティブ' } };
      } else if (type === 'select') {
        properties[name] = { select: { name: nextActive ? 'アクティブ' : '非アクティブ' } };
      }
    } else {
      // プロパティが見つからない場合はデフォルトで「アクティブ」チェックボックスを試みる
      properties['アクティブ'] = { checkbox: Boolean(nextActive) };
    }

    try {
      const res = await this._request(`pages/${pageId}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties })
      });
      return this._normalizeRecord(res);
    } catch (err) {
      if (err.message && err.message.includes('is not a property that exists')) {
        throw new Error(`Notionに「アクティブ」プロパティ（チェックボックス）が見つかりません。Notionデータベースに「アクティブ」（チェックボックス型）を追加してください。`);
      }
      throw err;
    }
  }

  /**
   * 新しい物品または場所レコードを作成 (Notion 2025-09-03 data_source_id / database_id 対応)
   */
  async createRecord({
    numericId = null,
    name,
    isItem = true,
    locationPageId = null,
    details = '',
    attributes = [],
    isAutoRegistered = false,
    coverUrl = null,
    code = null
  }) {
    // 既知の親DBコンテナIDと子データソースIDマッピング (目録/物理アドレス/セットアップ)
    const KNOWN_PARENT_DB = '3dc5e314fd47802eb00af61c71937780';
    const KNOWN_ITEM_DS = '3dc5e314fd47809088a5000b035baac0';
    const KNOWN_LOC_DS = '3e05e314fd4780e2a08a000b4bc0c86a';
    const KNOWN_CONFIG_DS = '3e65e314fd4780288a7d000bead0a79a';

    // 1. 作成先データソース / データベースIDの特定
    let rawTarget = isItem
      ? (state.config.itemDbId || state.config.dbId)
      : (state.config.locationDbId || state.config.dbId);

    if (!rawTarget && state.config.dbId) {
      rawTarget = state.config.dbId;
    }
    if (!rawTarget) throw new Error('作成先データベースが未設定です。');

    let targetId = NotionClient.extractDatabaseId(rawTarget);

    // ガード1: 既知親DB IDの場合は即座に子データソースIDへ自動解決
    let isKnownParent = false;
    if (targetId === KNOWN_PARENT_DB) {
      targetId = isItem ? KNOWN_ITEM_DS : KNOWN_LOC_DS;
      state.saveConfig({
        itemDbId: KNOWN_ITEM_DS,
        locationDbId: KNOWN_LOC_DS,
        configDbId: KNOWN_CONFIG_DS
      });
      isKnownParent = true;
    }

    // ガード2: targetId がマルチデータソースDBコンテナの場合の自動解決
    if (!isKnownParent) {
      try {
        const dbInfo = await this._request(`databases/${targetId}`, { method: 'GET' }).catch(() => null);
        if (dbInfo?.data_sources && dbInfo.data_sources.length >= 2) {
          const resolved = await this.resolveDatabases(targetId);
          const resolvedId = isItem ? resolved.itemDb?.id : resolved.locationDb?.id;
          if (resolvedId) {
            targetId = resolvedId;
          }
        }
      } catch {}
    }

    // 2. スキーマ取得
    let schema = null;
    try {
      schema = await this.getDatabaseSchema(targetId);
    } catch (e) {
      console.warn('[NotionClient] Schema fetch skipped:', e.message);
    }
    const props = schema?.properties || {};

    // 3. プロパティの構築 (実在するプロパティのみをホワイトリスト形式で厳格に適合)
    const properties = {};

    // タイトル (必須)
    const titlePropName = Object.values(props).find(p => p.type === 'title')?.name
      || state.config.propMapping?.title
      || '名前';
    properties[titlePropName] = {
      title: [{ text: { content: String(name || '新規アイテム') } }]
    };

    // 詳細 (rich_text)
    // バーコード(code)がある場合は詳細テキストの先頭に確実に含める（NotionスキーマにJAN列がなくても詳細欄で完全保持＆検索可能）
    let fullDetails = details ? String(details).trim() : '';
    if (code) {
      const strCode = String(code).trim();
      if (!fullDetails.includes(strCode)) {
        const codeLabel = (/^(978|979)/.test(strCode)) ? 'ISBN' : 'JAN';
        fullDetails = fullDetails ? `${codeLabel}: ${strCode}\n${fullDetails}` : `${codeLabel}: ${strCode}`;
      }
    }

    if (fullDetails) {
      const detailsProp = props['詳細']
        || Object.values(props).find(p => p.type === 'rich_text' && p.name === '詳細')
        || Object.values(props).find(p => p.type === 'rich_text' && !['ID', 'URL'].includes(p.name));
      if (detailsProp && detailsProp.type === 'rich_text') {
        properties[detailsProp.name] = {
          rich_text: [{ text: { content: fullDetails } }]
        };
      }
    }

    // 属性 (multi_select)
    if (Array.isArray(attributes) && attributes.length > 0) {
      const attrProp = props['属性'] || Object.values(props).find(p => p.type === 'multi_select');
      if (attrProp && attrProp.type === 'multi_select') {
        properties[attrProp.name] = {
          multi_select: attributes
            .map(tag => ({ name: String(tag).trim() }))
            .filter(t => t.name.length > 0)
        };
      }
    }

    // 物理アドレス / 場所 (relation) - 物品登録時
    if (isItem && locationPageId) {
      const locProp = props['物理アドレス']
        || props['現在地']
        || Object.values(props).find(p => p.type === 'relation' && !['目録', 'サブアイテム', '親アイテム'].includes(p.name));
      if (locProp && locProp.type === 'relation') {
        const locUuid = NotionClient.formatUuid(locationPageId);
        properties[locProp.name] = {
          relation: [{ id: locUuid }]
        };
      }
    }

    // 自動登録未確認 (checkbox)
    if (isAutoRegistered && props['自動登録未確認']?.type === 'checkbox') {
      properties['自動登録未確認'] = { checkbox: true };
    }

    // アクティブ (checkbox)
    if (isItem && props['アクティブ']?.type === 'checkbox') {
      properties['アクティブ'] = { checkbox: true };
    }

    // ※重要: Notionスキーマに実在しない「JAN」「JANコード」「バーコード」等の架空列は送信しません（HTTP 400エラー防止）。コードは「詳細」列に保持されます。

    // 4. parent の構築 (Notion 2025-09-03 data_source_id / database_id)
    const targetUuid = NotionClient.formatUuid(targetId);

    let res = null;
    let lastError = null;

    const tryPostPage = async (parentObj, propsObj) => {
      return await this._request('pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: parentObj,
          properties: propsObj
        })
      });
    };

    // 優先順位1: data_source_id (Notion 2025-09-03 マルチデータソースDB標準)
    try {
      res = await tryPostPage({ type: 'data_source_id', data_source_id: targetUuid }, properties);
    } catch (err1) {
      lastError = err1;
      console.warn('[NotionClient] data_source_id failed:', err1.message);

      // 自己修復A: 親DB IDだった場合、エラー本文内の child_data_source_ids から子データソースIDを抽出して即再試行
      const childDsIds = err1.data?.additional_data?.child_data_source_ids;
      if (Array.isArray(childDsIds) && childDsIds.length > 0) {
        const healedDsId = isItem ? childDsIds[0] : (childDsIds[1] || childDsIds[0]);
        console.info('[NotionClient] child_data_source_idsから子データソースIDを自動修復して再試行:', healedDsId);
        try {
          res = await tryPostPage({ type: 'data_source_id', data_source_id: healedDsId }, properties);
          state.saveConfig(isItem ? { itemDbId: healedDsId.replace(/-/g, '') } : { locationDbId: healedDsId.replace(/-/g, '') });
        } catch (healErr) {
          lastError = healErr;
        }
      }

      // 優先順位2: database_id (従来の単一DB)
      if (!res) {
        try {
          res = await tryPostPage({ type: 'database_id', database_id: targetUuid }, properties);
        } catch (err2) {
          lastError = err2;
          console.warn('[NotionClient] database_id failed, trying minimal title only:', err2.message);

          // 優先順位3: タイトルのみの最小構成 (プロパティ不一致の完全排除)
          const minimalProps = {
            [titlePropName]: properties[titlePropName]
          };
          try {
            res = await tryPostPage({ type: 'data_source_id', data_source_id: targetUuid }, minimalProps);
          } catch (err3) {
            try {
              res = await tryPostPage({ type: 'database_id', database_id: targetUuid }, minimalProps);
            } catch (err4) {
              lastError = err4;
            }
          }
        }
      }
    }

    if (!res) {
      throw new Error(`Notionへの登録に失敗しました: ${lastError?.message || '不明なエラー'}`);
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

    // アクティブフラグの検出 (checkbox または status/select)
    let isActive = null;
    const activeInfo = this._detectActiveProperty(props);

    if (activeInfo) {
      const { type, prop } = activeInfo;
      if (type === 'checkbox') {
        isActive = Boolean(prop.checkbox);
      } else if (type === 'status' || type === 'select') {
        const val = prop[type]?.name || '';
        isActive = (val === 'アクティブ' || val.toLowerCase() === 'active');
      }
    }

    if (!statusVal && isActive !== null) {
      statusVal = isActive ? 'アクティブ' : '非アクティブ';
    }

    if (!notesVal && attributes.length > 0) {
      notesVal = attributes.join(' / ');
    }

    // カバー画像 (cover) の抽出
    let coverUrl = null;
    if (page.cover) {
      if (page.cover.type === 'external' && page.cover.external?.url) {
        coverUrl = page.cover.external.url;
      } else if (page.cover.type === 'file' && page.cover.file?.url) {
        coverUrl = page.cover.file.url;
      }
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
      coverUrl,
      url: page.url,
      rawProperties: props
    };
  }
}

export const notion = new NotionClient();
