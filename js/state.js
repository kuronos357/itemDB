/**
 * itemDB - State Management
 * 
 * アプリケーションの設定、現在のスキャン状態、操作モード、履歴を管理します。
 */

export const AppMode = {
  HOME: 'HOME',                       // ホーム・通常スキャナ待機
  ITEM_VIEW: 'ITEM_VIEW',             // 物品詳細表示
  CHANGE_LOCATION_PENDING: 'CHANGE_LOCATION_PENDING', // 物品の移動先「場所」スキャン待ち
  LOCATION_VIEW: 'LOCATION_VIEW',     // 場所詳細表示（所属物品一覧）
  LOCATION_EDIT_BATCH: 'LOCATION_EDIT_BATCH', // 場所起点の一括編集（連続スキャンで追加/削除）
  SETTINGS: 'SETTINGS'                // 設定画面
};

const STORAGE_KEYS = {
  NOTION_API_KEY: 'itemdb_notion_api_key',
  NOTION_DB_ID: 'itemdb_notion_db_id',
  NOTION_ITEM_DB_ID: 'itemdb_notion_item_db_id',
  NOTION_LOCATION_DB_ID: 'itemdb_notion_location_db_id',
  NOTION_CONFIG_DB_ID: 'itemdb_notion_config_db_id',
  NOTION_PROXY_MODE: 'itemdb_notion_proxy_mode', // 'auto', 'cloudflare', 'corsproxy', 'direct', 'custom'
  CUSTOM_PROXY_URL: 'itemdb_custom_proxy_url',
  JEV_API_KEY: 'itemdb_jev_api_key',
  JEV_MAX_ATTRIBUTES: 'itemdb_jev_max_attributes',
  GEMINI_API_KEY: 'itemdb_gemini_api_key',
  GEMINI_MODEL: 'itemdb_gemini_model',
  YAHOO_APP_ID: 'itemdb_yahoo_app_id',
  PROP_MAPPING: 'itemdb_prop_mapping',
  HISTORY: 'itemdb_scan_history'
};

const DEFAULT_PROP_MAPPING = {
  id: 'ID',
  title: '名前',
  type: '種別',
  location: '物理アドレス',
  status: '状態',
  notes: '属性'
};

class StateStore extends EventTarget {
  constructor() {
    super();
    this.config = {
      apiKey: localStorage.getItem(STORAGE_KEYS.NOTION_API_KEY) || '',
      dbId: localStorage.getItem(STORAGE_KEYS.NOTION_DB_ID) || '',
      itemDbId: localStorage.getItem(STORAGE_KEYS.NOTION_ITEM_DB_ID) || '',
      locationDbId: localStorage.getItem(STORAGE_KEYS.NOTION_LOCATION_DB_ID) || '',
      configDbId: localStorage.getItem(STORAGE_KEYS.NOTION_CONFIG_DB_ID) || '',
      itemDbTitle: '',
      locationDbTitle: '',
      configDbTitle: '',
      proxyMode: localStorage.getItem(STORAGE_KEYS.NOTION_PROXY_MODE) || 'cloudflare',
      customProxyUrl: localStorage.getItem(STORAGE_KEYS.CUSTOM_PROXY_URL) || '',
      jevApiKey: localStorage.getItem(STORAGE_KEYS.JEV_API_KEY) || '',
      jevMaxAttributes: parseInt(localStorage.getItem(STORAGE_KEYS.JEV_MAX_ATTRIBUTES) || '3', 10) || 3,
      geminiApiKey: localStorage.getItem(STORAGE_KEYS.GEMINI_API_KEY) || '',
      geminiModel: localStorage.getItem(STORAGE_KEYS.GEMINI_MODEL) || 'gemini-3.1-flash-lite',
      yahooAppId: localStorage.getItem(STORAGE_KEYS.YAHOO_APP_ID) || '',
      propMapping: this._loadPropMapping()
    };

    // 以前のセッションで逆転保存されたIDや旧設定の自己修復
    this.autoHealConfig();

    this.currentMode = AppMode.HOME;
    this.currentItem = null;      // 現在表示中の物品データ
    this.currentLocation = null;  // 現在表示中の場所データ
    this.parentLocation = null;   // 現在の場所の親場所データ（階層構造）
    this.subLocations = [];       // 現在の場所に含まれる子場所データ（階層構造）
    this.locationItems = [];      // 現在の場所に属している物品一覧
    this.history = this._loadHistory();
    this.pendingMoveItem = null;  // 場所変更待ち状態の物品データ
    this.isProcessing = false;    // APIリクエスト中フラグ
  }

  /**
   * 過去バージョンの誤認（物理アドレスが物品DBとして保存されていたケース等）を自己修復
   */
  autoHealConfig() {
    let changed = false;
    const updates = {};

    const cleanItem = (this.config.itemDbId || '').replace(/-/g, '');
    const cleanLoc = (this.config.locationDbId || '').replace(/-/g, '');

    // 既知の「目録(物品)」と「物理アドレス(場所)」および親コンテナDBの自動補正
    const KNOWN_ITEM_DS = '3dc5e314fd47809088a5000b035baac0';
    const KNOWN_LOC_DS = '3e05e314fd4780e2a08a000b4bc0c86a';
    const KNOWN_PARENT_DB = '3dc5e314fd47802eb00af61c71937780';

    const cleanDb = (this.config.dbId || '').replace(/-/g, '');

    // dbId が親コンテナではなく子データソース (目録 or 物理アドレス) になっていた場合、親DBに補正
    if (cleanDb === KNOWN_ITEM_DS || cleanDb === KNOWN_LOC_DS) {
      console.info('[State] dbId を親データベースIDに自動修復します');
      updates.dbId = KNOWN_PARENT_DB;
      if (!cleanItem) updates.itemDbId = KNOWN_ITEM_DS;
      if (!cleanLoc) updates.locationDbId = KNOWN_LOC_DS;
      changed = true;
    } else if (cleanDb === KNOWN_PARENT_DB && (!cleanItem || !cleanLoc)) {
      updates.itemDbId = KNOWN_ITEM_DS;
      updates.locationDbId = KNOWN_LOC_DS;
      changed = true;
    }

    if (cleanItem === KNOWN_LOC_DS && cleanLoc === KNOWN_ITEM_DS) {
      console.warn('[State] 物品DBと場所DBの割り当て逆転を自動修復します');
      updates.itemDbId = KNOWN_ITEM_DS;
      updates.locationDbId = KNOWN_LOC_DS;
      changed = true;
    } else if (cleanItem === KNOWN_LOC_DS && !cleanLoc) {
      updates.itemDbId = KNOWN_ITEM_DS;
      updates.locationDbId = KNOWN_LOC_DS;
      changed = true;
    }

    // propMappingの旧プロパティ名「現在地」を「物理アドレス」に自動移行
    const mapping = { ...this.config.propMapping };
    if (mapping.location === '現在地') {
      mapping.location = '物理アドレス';
      updates.propMapping = mapping;
      changed = true;
    }

    if (changed) {
      this.saveConfig(updates);
    }
  }

  _loadPropMapping() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.PROP_MAPPING);
      return saved ? { ...DEFAULT_PROP_MAPPING, ...JSON.parse(saved) } : { ...DEFAULT_PROP_MAPPING };
    } catch {
      return { ...DEFAULT_PROP_MAPPING };
    }
  }

  _loadHistory() {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.HISTORY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  saveConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    if (newConfig.apiKey !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_API_KEY, newConfig.apiKey);
    if (newConfig.dbId !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_DB_ID, newConfig.dbId);
    if (newConfig.itemDbId !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_ITEM_DB_ID, newConfig.itemDbId);
    if (newConfig.locationDbId !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_LOCATION_DB_ID, newConfig.locationDbId);
    if (newConfig.configDbId !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_CONFIG_DB_ID, newConfig.configDbId);
    if (newConfig.proxyMode !== undefined) localStorage.setItem(STORAGE_KEYS.NOTION_PROXY_MODE, newConfig.proxyMode);
    if (newConfig.customProxyUrl !== undefined) localStorage.setItem(STORAGE_KEYS.CUSTOM_PROXY_URL, newConfig.customProxyUrl);
    if (newConfig.jevApiKey !== undefined) localStorage.setItem(STORAGE_KEYS.JEV_API_KEY, newConfig.jevApiKey);
    if (newConfig.jevMaxAttributes !== undefined) {
      localStorage.setItem(STORAGE_KEYS.JEV_MAX_ATTRIBUTES, String(newConfig.jevMaxAttributes));
    }
    if (newConfig.geminiApiKey !== undefined) {
      localStorage.setItem(STORAGE_KEYS.GEMINI_API_KEY, newConfig.geminiApiKey);
    }
    if (newConfig.geminiModel !== undefined) {
      localStorage.setItem(STORAGE_KEYS.GEMINI_MODEL, newConfig.geminiModel);
    }
    if (newConfig.yahooAppId !== undefined) {
      localStorage.setItem(STORAGE_KEYS.YAHOO_APP_ID, newConfig.yahooAppId);
    }
    if (newConfig.propMapping !== undefined) {
      localStorage.setItem(STORAGE_KEYS.PROP_MAPPING, JSON.stringify(this.config.propMapping));
    }
    this.dispatchEvent(new CustomEvent('config-changed', { detail: this.config }));
  }

  isConfigured() {
    return Boolean(this.config.apiKey && (this.config.itemDbId || this.config.locationDbId || this.config.dbId));
  }

  addHistory(entry) {
    // entry: { id, name, type: 'item'|'location', timestamp }
    this.history = [
      entry,
      ...this.history.filter(h => h.id !== entry.id)
    ].slice(0, 30);
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(this.history));
    this.dispatchEvent(new CustomEvent('history-changed', { detail: this.history }));
  }

  clearHistory() {
    this.history = [];
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    this.dispatchEvent(new CustomEvent('history-changed', { detail: this.history }));
  }

  setMode(mode, data = {}) {
    this.currentMode = mode;
    this.dispatchEvent(new CustomEvent('mode-changed', { detail: { mode, data } }));
  }

  setProcessing(val) {
    this.isProcessing = val;
    this.dispatchEvent(new CustomEvent('processing-changed', { detail: val }));
  }

  /**
   * JIS X 0560 / 設計仕様に基づく偶奇ID判定
   * 偶数 => 物品 (Item)
   * 奇数 => 場所 (Location)
   */
  static parseId(raw) {
    if (raw === null || raw === undefined) return null;
    const str = String(raw).trim();
    if (!/^\d+$/.test(str)) return null;
    const num = BigInt(str);
    const isEven = (num % 2n === 0n);
    return {
      raw: str,
      num,
      isItem: isEven,
      isLocation: !isEven,
      typeLabel: isEven ? '物品' : '場所'
    };
  }
}

export const APP_VERSION = 'v38';
export const state = new StateStore();
