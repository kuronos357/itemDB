/**
 * itemDB - Application Orchestrator
 * 
 * イベントルーティング、URLパラメータ処理、状態遷移、
 * 物品移動・場所一括編集のビジネスロジックを統合します。
 */

import { AppMode, state } from './state.js';
import { notion } from './notion.js';
import { scanner } from './scanner.js';
import { feedback } from './audio.js';
import { ui } from './ui.js';
import { BarcodeService } from './barcode.js';
import { JevService } from './jev.js';

class Application {
  constructor() {
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    // 1. 設定の自己修復（逆転IDや旧プロパティ名などの補正）
    state.autoHealConfig();
    if (state.isConfigured() && state.config.dbId) {
      notion.resolveDatabases(state.config.dbId).catch(() => {});
    }

    ui.init();
    this._bindEvents();

    // 2. URLパラメータの初期判定 (?dbid=...&api=... または ?id=...)
    const handledUrl = await this._handleUrlParams();

    // 3. 該当するURLパラメータがなければホーム（待機スキャン）画面を描画
    if (!handledUrl) {
      this.switchMode(AppMode.HOME);
    }

    // 4. Web NFC をバックグラウンドで開始（対応ブラウザのみ）
    scanner.startNfc().catch(() => {});

    // 5. Service Worker登録 (PWA)
    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
    }
  }

  _bindEvents() {
    // スキャナーイベント
    scanner.addEventListener('scan-success', (e) => {
      this.onIdScanned(e.detail.id);
    });

    scanner.addEventListener('barcode-scanned', (e) => {
      this.onBarcodeScanned(e.detail.code);
    });

    scanner.addEventListener('setup-config-scanned', (e) => {
      this._applySetupConfig(e.detail);
    });

    scanner.addEventListener('setup-url-scanned', (e) => {
      this._applySetupConfig(e.detail);
    });

    scanner.addEventListener('scan-invalid', () => {
      ui.showToast('有効なID (数字) またはURLが検出されませんでした', 'warning');
    });

    // カメラ状態変更のUI同期 (背面/前面/停止)
    scanner.addEventListener('camera-state-changed', (e) => {
      ui.updateCameraStateUI(e.detail.state);
    });

    // 設定モーダルの開閉
    document.getElementById('btn-header-settings')?.addEventListener('click', () => {
      ui.renderSettingsModal();
    });

    // 設定モーダルの保存・閉じる
    document.getElementById('btn-save-settings')?.addEventListener('click', () => {
      this._saveSettingsFromModal();
    });

    document.getElementById('btn-close-settings')?.addEventListener('click', () => {
      document.getElementById('settings-modal')?.classList.add('hidden');
    });

    document.getElementById('btn-test-connection')?.addEventListener('click', () => {
      this._testConnection();
    });

    document.getElementById('btn-test-jev')?.addEventListener('click', () => {
      this._testJevConnection();
    });

    // データベースURL/ID入力時のリアルタイム抽出表示
    document.getElementById('input-db-id')?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      const detectedEl = document.getElementById('detected-db-id');
      if (!detectedEl) return;
      if (val) {
        const extracted = notion.constructor.extractDatabaseId(val);
        if (extracted) {
          detectedEl.innerHTML = `✓ 検出されたID: <code style="color:var(--color-item);">${extracted}</code>`;
        } else {
          detectedEl.textContent = '有効な32桁のIDまたはNotion URLを入力してください。';
        }
      } else {
        detectedEl.textContent = 'NotionのURLをそのまま貼り付けても自動抽出されます。';
      }
    });

    document.getElementById('btn-generate-setup-qr')?.addEventListener('click', () => {
      this._generateSetupQr();
    });

    document.getElementById('btn-copy-setup-url')?.addEventListener('click', () => {
      this._copySetupUrl();
    });

    // 動的コンテンツ内のクリックイベント委譲
    document.getElementById('app-main').addEventListener('click', (e) => {
      // 未設定バナーの設定ボタン
      if (e.target.closest('#btn-open-settings')) {
        ui.renderSettingsModal();
        return;
      }

      // テンキー手動入力ボタン
      if (e.target.closest('#btn-manual-id')) {
        ui.openKeypad('IDテンキー入力', '', (val) => this.onIdScanned(val));
        return;
      }

      // カメラ切替 (背面 -> 前面 -> 停止 -> 背面)
      if (e.target.closest('#btn-toggle-camera')) {
        scanner.cycleCamera('qr-reader').catch(() => {});
        return;
      }

      // 物品詳細: URLコピー
      const copyItemBtn = e.target.closest('#btn-copy-item-url');
      if (copyItemBtn) {
        const id = copyItemBtn.dataset.itemId || state.currentItem?.id;
        if (id) {
          const url = ui._generateLabelUrl(id, false);
          navigator.clipboard.writeText(url).then(() => {
            ui.showToast('物品URLをコピーしました', 'success');
            feedback.playSuccess();
          }).catch(() => {
            ui.showToast('URLのコピーに失敗しました', 'error');
          });
        }
        return;
      }

      // 場所詳細: URLコピー
      const copyLocBtn = e.target.closest('#btn-copy-location-url');
      if (copyLocBtn) {
        const id = copyLocBtn.dataset.locId || state.currentLocation?.id;
        if (id) {
          const url = ui._generateLabelUrl(id, false);
          navigator.clipboard.writeText(url).then(() => {
            ui.showToast('場所URLをコピーしました', 'success');
            feedback.playSuccess();
          }).catch(() => {
            ui.showToast('URLのコピーに失敗しました', 'error');
          });
        }
        return;
      }

      // ラベル・QR・NFC発行モーダル起動
      if (e.target.closest('#btn-open-label-modal')) {
        if (state.currentMode === AppMode.ITEM_VIEW && state.currentItem) {
          ui.renderLabelModal(state.currentItem, 'item');
        } else if (state.currentMode === AppMode.LOCATION_VIEW && state.currentLocation) {
          ui.renderLabelModal(state.currentLocation, 'location');
        }
        return;
      }

      // 履歴消去
      if (e.target.closest('#btn-clear-history')) {
        if (confirm('最近のスキャン履歴を消去しますか？')) {
          state.clearHistory();
          ui.renderHomeView();
        }
        return;
      }

      // 物品画面: 「場所変更」ボタン
      if (e.target.closest('#btn-change-location')) {
        this.switchMode(AppMode.CHANGE_LOCATION_PENDING);
        return;
      }

      // アクティブ・非アクティブ切り替えボタン
      const toggleActiveBtn = e.target.closest('#btn-toggle-active');
      if (toggleActiveBtn) {
        const pageId = toggleActiveBtn.dataset.pageId;
        const currentActive = toggleActiveBtn.dataset.isActive === 'true';
        this._toggleActiveStatus(pageId, !currentActive);
        return;
      }

      // 場所画面: 「物品を追加」ボタン（手入力・スキャンで直ちに現在地に登録）
      if (e.target.closest('#btn-add-item-to-location')) {
        ui.openKeypad('物品ID (偶数) を入力して追加', '', (val) => this._addItemToCurrentLocation(val));
        return;
      }

      // 場所画面: 物品一覧の「解除」ボタン (親リンクへの遷移を防止)
      const unlinkBtn = e.target.closest('.btn-unlink-item');
      if (unlinkBtn) {
        e.preventDefault();
        e.stopPropagation();
        const pageId = unlinkBtn.dataset.itemPageId;
        const name = unlinkBtn.dataset.itemName;
        if (pageId) this._removeItemFromCurrentLocation(pageId, name);
        return;
      }

      // 場所変更待ち画面: 手入力
      if (e.target.closest('#btn-manual-location-id')) {
        ui.openKeypad('場所ID (奇数) を入力', '', (val) => this.onIdScanned(val));
        return;
      }

      // 場所変更待ち画面: キャンセル
      if (e.target.closest('#btn-cancel-pending')) {
        if (state.currentItem) {
          this.switchMode(AppMode.ITEM_VIEW);
        } else {
          this.switchMode(AppMode.HOME);
        }
        return;
      }

      // 場所画面: 「一括棚卸」ボタン
      if (e.target.closest('#btn-edit-batch')) {
        this.switchMode(AppMode.LOCATION_EDIT_BATCH);
        return;
      }

      // 一括編集モード: 編集完了
      if (e.target.closest('#btn-finish-batch')) {
        this.switchMode(AppMode.LOCATION_VIEW);
        return;
      }

      // 一括編集モード: 手入力
      if (e.target.closest('#btn-manual-batch-item')) {
        ui.openKeypad('物品ID (偶数) を入力', '', (val) => this.onIdScanned(val));
        return;
      }
    });
  }

  /**
   * 起動時のURLクエリパラメータ処理
   */
  async _handleUrlParams() {
    const params = new URLSearchParams(window.location.search);

    // 1. 初期設定URL: ?dbid=...&api=... 等
    const dbid = params.get('dbid') || params.get('db') || params.get('db_id') || params.get('database_id') || params.get('databaseId') || params.get('itemDbId') || params.get('itemdb');
    const api = params.get('api') || params.get('apiKey') || params.get('api_key') || params.get('key') || params.get('token') || params.get('secret');
    const locid = params.get('locationDbId') || params.get('locid') || params.get('location_db_id') || params.get('locationdb');
    const proxy = params.get('proxy') || params.get('proxyMode');
    const jev = params.get('jev') || params.get('jevApiKey') || params.get('jev_api_key');
    const jevMax = params.get('jevmax') || params.get('jev_max') || params.get('jevMax');
    const id = params.get('id');

    if (dbid || api || jev || jevMax) {
      const hasDirectId = (id && /^\d+$/.test(id));
      await this._applySetupConfig({
        dbId: dbid,
        apiKey: api,
        locationDbId: locid,
        proxyMode: proxy,
        jevApiKey: jev,
        jevMaxAttributes: jevMax ? parseInt(jevMax, 10) : undefined
      }, null, !hasDirectId);

      // URLから秘密トークンを除去
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);

      if (hasDirectId) {
        await this.onIdScanned(id);
        return true;
      }
      return false; // ホームへ
    }

    // 2. ID読み込みURL: ?id=1234
    if (id && /^\d+$/.test(id)) {
      await this.onIdScanned(id);
      return true;
    }

    return false;
  }

  /**
   * 初期設定の適用
   */
  async _applySetupConfig(configInput, legacyApi, autoSwitchHome = true) {
    let config = configInput;
    if (typeof configInput === 'string') {
      config = { dbId: configInput, apiKey: legacyApi };
    }
    if (!config || typeof config !== 'object') return;

    ui.setLoading(true, '設定を登録中...');

    const updates = {};
    if (config.apiKey) updates.apiKey = config.apiKey;
    if (config.dbId) updates.dbId = config.dbId;
    if (config.itemDbId) updates.itemDbId = config.itemDbId;
    if (config.locationDbId) updates.locationDbId = config.locationDbId;
    if (config.proxyMode) updates.proxyMode = config.proxyMode;
    if (config.customProxyUrl) updates.customProxyUrl = config.customProxyUrl;
    if (config.jevApiKey) updates.jevApiKey = config.jevApiKey;
    if (config.jevMaxAttributes !== undefined) updates.jevMaxAttributes = config.jevMaxAttributes;

    state.saveConfig(updates);

    // APIキーとDB IDの両方が揃っている場合は接続テストを実施
    if (state.isConfigured()) {
      try {
        const conn = await notion.testConnection();
        if (conn.isDual) {
          ui.showToast(`設定完了: 物品「${conn.itemDb.title}」⇄ 場所「${conn.locationDb.title}」に接続しました`, 'success', 4500);
        } else {
          ui.showToast(`設定完了: 「${conn.itemDb.title}」に接続しました`, 'success', 4000);
        }
        feedback.playSuccess();
      } catch (err) {
        ui.showToast(`設定を保存しましたが接続確認でエラー: ${err.message}`, 'warning', 5000);
        feedback.playError();
      } finally {
        ui.setLoading(false);
        if (autoSwitchHome) {
          this.switchMode(AppMode.HOME);
        }
      }
    } else {
      // 一部のみ設定できた場合 (例: APIキーのみスキャンした)
      ui.setLoading(false);
      feedback.playScan();
      if (config.apiKey && !state.config.dbId && !state.config.itemDbId) {
        ui.showToast('APIキーを登録しました。データベースIDを設定してください。', 'info', 4500);
      } else if ((config.dbId || config.itemDbId) && !state.config.apiKey) {
        ui.showToast('データベースIDを登録しました。APIキーを設定してください。', 'info', 4500);
      } else {
        ui.showToast('設定を読み込みました。不足している項目を設定してください。', 'info', 4500);
      }
      ui.renderSettingsModal();
    }
  }

  /**
   * 画面モードの切り替えとカメラ制御
   */
  async switchMode(mode, data = {}) {
    state.currentMode = mode;

    // 前のカメラを停止
    await scanner.stopCamera();

    switch (mode) {
      case AppMode.HOME:
        ui.renderHomeView();
        if (scanner.cameraEnabled) {
          setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
        } else {
          ui.updateCameraStateUI('off');
        }
        break;

      case AppMode.ITEM_VIEW:
        ui.renderItemView(state.currentItem, state.currentLocation, state.parentLocation);
        break;

      case AppMode.CHANGE_LOCATION_PENDING:
        ui.renderChangeLocationPendingView(state.currentItem);
        if (scanner.cameraEnabled) {
          setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
        } else {
          ui.updateCameraStateUI('off');
        }
        break;

      case AppMode.LOCATION_VIEW:
        ui.renderLocationView(state.currentLocation, state.locationItems, state.subLocations, state.parentLocation);
        break;

      case AppMode.LOCATION_EDIT_BATCH:
        ui.renderLocationEditBatchView(state.currentLocation, state.locationItems);
        if (scanner.cameraEnabled) {
          setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
        } else {
          ui.updateCameraStateUI('off');
        }
        break;
    }
  }

  /**
   * IDがスキャンまたは手入力された際の中核ハンドラ
   */
  async onIdScanned(rawId) {
    const parsed = state.constructor.parseId(rawId);
    if (!parsed) {
      ui.showToast('IDは数字で指定してください', 'error');
      feedback.playError();
      return;
    }

    if (!state.isConfigured()) {
      ui.showToast('Notionの設定を先に行ってください', 'warning');
      ui.renderSettingsModal();
      return;
    }

    const { num, isItem, isLocation } = parsed;
    const numericStr = parsed.raw;

    // 移動待ち・一括編集以外のモードで、URLと異なるIDが指定された場合はURL遷移を行う
    const currentUrlId = new URLSearchParams(window.location.search).get('id');
    if (state.currentMode !== AppMode.CHANGE_LOCATION_PENDING &&
        state.currentMode !== AppMode.LOCATION_EDIT_BATCH &&
        currentUrlId !== numericStr &&
        state.currentMode !== null) {
      window.location.href = `?id=${numericStr}`;
      return;
    }

    // モード別の分岐処理
    switch (state.currentMode) {
      case AppMode.CHANGE_LOCATION_PENDING:
        await this._handleChangeLocationScan(numericStr, isLocation);
        break;

      case AppMode.LOCATION_EDIT_BATCH:
        await this._handleBatchEditScan(numericStr, isItem);
        break;

      default:
        // ホームまたは通常表示中のスキャン
        await this._handleNormalScan(numericStr, isItem);
        break;
    }
  }

  /**
   * 通常スキャン (物品 or 場所の個別ロード)
   */
  async _handleNormalScan(numericStr, isItem) {
    ui.setLoading(true, isItem ? '物品データを取得中...' : '場所データを取得中...');

    try {
      let record = await notion.findRecordById(numericStr, isItem);

      // レコードが存在しない場合、新規登録を提案・作成
      if (!record) {
        const typeName = isItem ? '物品' : '場所';
        const ok = confirm(`ID #${numericStr} は未登録の【${typeName}】です。Notionに新規作成しますか？`);
        if (!ok) {
          ui.setLoading(false);
          return;
        }
        record = await notion.createRecord({
          numericId: numericStr,
          name: `${typeName} #${numericStr}`,
          isItem
        });
        ui.showToast(`${typeName} #${numericStr} をNotionに登録しました`, 'success');
      }

      state.addHistory({
        id: numericStr,
        name: record.name,
        type: isItem ? 'item' : 'location',
        timestamp: Date.now()
      });

      if (isItem) {
        state.currentItem = record;
        // 現在地の場所レコードを取得 (リレーションから場所ページを取得)
        state.currentLocation = null;
        state.parentLocation = null;
        if (record.locationPageIds && record.locationPageIds.length > 0) {
          try {
            state.currentLocation = await notion.fetchPage(record.locationPageIds[0]);
            if (state.currentLocation) {
              state.parentLocation = await notion.getParentLocation(state.currentLocation);
            }
          } catch (e) {
            console.warn('[App] Could not fetch parent location:', e);
          }
        }
        await this.switchMode(AppMode.ITEM_VIEW);
      } else {
        // 場所 (Location)
        state.currentLocation = record;
        // 所属物品の取得（場所自体の目録リレーション＋物品DB検索の両面から確実に取得）
        state.locationItems = await notion.getItemsForLocation(record);
        // 親場所（上位階層: カラーボックスなど）の取得
        state.parentLocation = await notion.getParentLocation(record);
        // 子場所（下位階層: １段目、２段目などの段・ボックス）の取得
        state.subLocations = await notion.getSubLocations(record);

        await this.switchMode(AppMode.LOCATION_VIEW);
      }
    } catch (err) {
      ui.showToast(`取得エラー: ${err.message}`, 'error');
      feedback.playError();
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * バーコード（JAN/ISBN）スキャン時のハンドラ
   */
  async onBarcodeScanned(code) {
    if (!state.isConfigured()) {
      ui.showToast('Notionの設定を先に行ってください', 'warning');
      ui.renderSettingsModal();
      return;
    }

    ui.setLoading(true, 'バーコード情報を検索中...');

    try {
      // 1. Notion既存アイテムの重複チェック
      const existingRecord = await notion.findRecordByBarcode(code);

      // 2. 既存の属性オプション（Notion DBの属性選択肢）を取得
      const candidateAttributes = await notion.getAttributeOptions();

      // 3. openBD / Google Books (ISBN) または Open Food Facts / Jev (JAN) による情報取得
      const itemData = await BarcodeService.lookup(code, {
        jevApiKey: state.config.jevApiKey,
        jevMaxAttributes: state.config.jevMaxAttributes,
        candidateAttributes
      });

      ui.setLoading(false);

      // 4. プレビュー確認モーダル表示 (保管場所は現在の画面状態に応じて自動判定)
      ui.renderBarcodeModal(
        itemData,
        existingRecord,
        async (formData) => {
          await this._registerBarcodeItem(formData);
        }
      );
    } catch (err) {
      ui.setLoading(false);
      ui.showToast(`バーコード検索エラー: ${err.message}`, 'error');
      feedback.playError();
    }
  }

  /**
   * バーコード新規アイテムのNotionへの登録処理
   */
  async _registerBarcodeItem(formData) {
    ui.setLoading(true, 'Notionにアイテムを登録中...');

    try {
      // 保存場所の自動判定：場所画面を開いている状態ならその場所に自動紐付け、ホーム等なら未設定(null)
      const assignedLocationPageId = (state.currentMode === AppMode.LOCATION_VIEW && state.currentLocation)
        ? state.currentLocation.pageId
        : null;

      let finalAttributes = formData.attributes || [];

      // タイトルが入力されており、属性が未分類（空または市販品のみ）かつJev APIキーがある場合は登録前にJev分類を試行
      if ((finalAttributes.length === 0 || (finalAttributes.length === 1 && finalAttributes[0] === '市販品')) &&
          state.config.jevApiKey && formData.title && !formData.title.startsWith('市販品 (JAN:')) {
        try {
          const candidateAttrs = await notion.getAttributeOptions();
          if (candidateAttrs.length > 0) {
            const jevAttrs = await JevService.classify(
              formData.title,
              state.config.jevApiKey,
              candidateAttrs,
              { maxAttributes: state.config.jevMaxAttributes }
            );
            if (Array.isArray(jevAttrs) && jevAttrs.length > 0) {
              finalAttributes = jevAttrs;
            }
          }
        } catch (jevErr) {
          console.warn('[App] Jev classification on register failed:', jevErr);
        }
      }

      const record = await notion.createRecord({
        numericId: null, // Notion側で自動採番
        name: formData.title,
        isItem: true,
        locationPageId: assignedLocationPageId,
        details: formData.details,
        attributes: finalAttributes,
        isAutoRegistered: true,
        coverUrl: formData.coverUrl
      });

      feedback.playSuccess();
      ui.showToast(`「${record.name}」をNotionに登録しました！`, 'success', 3500);

      // 履歴に追加
      state.addHistory({
        id: record.id != null ? record.id : record.pageId.slice(0, 8),
        name: record.name,
        type: 'item',
        pageId: record.pageId,
        timestamp: Date.now()
      });

      // もし現在場所画面を開いていて、その場所に登録した場合はリスト更新
      if (state.currentMode === AppMode.LOCATION_VIEW && state.currentLocation) {
        state.locationItems.unshift(record);
        ui.renderLocationView(state.currentLocation, state.locationItems, state.subLocations, state.parentLocation);
      } else if (state.currentMode === AppMode.HOME) {
        // ホーム画面の履歴等を再描画
        ui.renderHomeView();
      }
    } catch (err) {
      feedback.playError();
      ui.showToast(`Notion登録エラー: ${err.message}`, 'error');
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * 場所詳細画面から物品を直接追加（手入力またはスキャン）
   */
  async _addItemToCurrentLocation(rawId) {
    const parsed = state.constructor.parseId(rawId);
    if (!parsed || !parsed.isItem) {
      ui.showToast('追加する物品は偶数IDで指定してください', 'warning');
      feedback.playError();
      return;
    }

    const currentLoc = state.currentLocation;
    if (!currentLoc) return;

    ui.setLoading(true, `物品 #${parsed.raw} を確認中...`);
    try {
      let itemRecord = await notion.findRecordById(parsed.raw, true);
      if (!itemRecord) {
        const ok = confirm(`ID #${parsed.raw} は未登録の物品です。新規作成して「${currentLoc.name}」に追加しますか？`);
        if (!ok) {
          ui.setLoading(false);
          return;
        }
        itemRecord = await notion.createRecord({
          numericId: parsed.raw,
          name: `物品 #${parsed.raw}`,
          isItem: true,
          locationPageId: currentLoc.pageId
        });
      } else {
        itemRecord = await notion.updateItemLocation(itemRecord.pageId, currentLoc.pageId);
      }

      // locationItems に即座に反映
      const existsIndex = state.locationItems.findIndex(i => String(i.id) === String(parsed.raw));
      if (existsIndex >= 0) {
        state.locationItems[existsIndex] = itemRecord;
      } else {
        state.locationItems.unshift(itemRecord);
      }

      feedback.playAdded();
      ui.showToast(`「${itemRecord.name}」を「${currentLoc.name}」に追加しました`, 'added');
      ui.renderLocationView(state.currentLocation, state.locationItems, state.subLocations, state.parentLocation);
    } catch (err) {
      ui.showToast(`追加エラー: ${err.message}`, 'error');
      feedback.playError();
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * 場所詳細画面から物品の紐付けを解除
   */
  async _removeItemFromCurrentLocation(itemPageId, itemName) {
    const ok = confirm(`「${itemName}」をこの場所から解除しますか？`);
    if (!ok) return;

    ui.setLoading(true, '場所の紐付けを解除中...');
    try {
      await notion.updateItemLocation(itemPageId, null);
      state.locationItems = state.locationItems.filter(i => i.pageId !== itemPageId);
      feedback.playRemoved();
      ui.showToast(`「${itemName}」の配置を解除しました`, 'removed');
      ui.renderLocationView(state.currentLocation, state.locationItems, state.subLocations, state.parentLocation);
    } catch (err) {
      ui.showToast(`解除エラー: ${err.message}`, 'error');
      feedback.playError();
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * 物品起点での「場所変更」スキャン処理
   */
  async _handleChangeLocationScan(numericStr, isLocation) {
    if (!isLocation) {
      ui.showToast('移動先には【場所】(奇数ID) をスキャンしてください', 'warning');
      feedback.playError();
      return;
    }

    ui.setLoading(true, '移動先の場所を確認中...');

    try {
      let locationRecord = await notion.findRecordById(numericStr, false);
      if (!locationRecord) {
        const ok = confirm(`場所ID #${numericStr} は未登録です。Notionに新規作成して移動しますか？`);
        if (!ok) {
          ui.setLoading(false);
          return;
        }
        locationRecord = await notion.createRecord({
          numericId: numericStr,
          name: `場所 #${numericStr}`,
          isItem: false
        });
      }

      // 物品の現在地をNotion上で更新
      const updatedItem = await notion.updateItemLocation(
        state.currentItem.pageId,
        locationRecord.pageId
      );

      state.currentItem = updatedItem;
      state.currentLocation = locationRecord;

      feedback.playSuccess();
      ui.showToast(`置き場所を「${locationRecord.name}」に変更しました`, 'success', 3500);

      if (window.location.search !== `?id=${state.currentItem.id}`) {
        window.history.replaceState({}, '', `?id=${state.currentItem.id}`);
      }

      await this.switchMode(AppMode.ITEM_VIEW);
    } catch (err) {
      ui.showToast(`移動更新エラー: ${err.message}`, 'error');
      feedback.playError();
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * 物品または場所のアクティブ／非アクティブ切り替え
   */
  async _toggleActiveStatus(pageId, nextActive) {
    if (!pageId) return;

    ui.setLoading(true, nextActive ? 'アクティブに設定中...' : '非アクティブに設定中...');

    try {
      const rawProps = (state.currentItem?.pageId === pageId ? state.currentItem?.rawProperties : null)
                    || (state.currentLocation?.pageId === pageId ? state.currentLocation?.rawProperties : null);
      const updated = await notion.updateActiveStatus(pageId, nextActive, rawProps);
      feedback.playSuccess();
      ui.showToast(nextActive ? '🟢 アクティブに設定しました' : '⚪ 非アクティブに設定しました', 'success');

      // 現在表示中のレコードを更新して再描画
      if (state.currentItem && state.currentItem.pageId === pageId) {
        state.currentItem.isActive = nextActive;
        state.currentItem.status = nextActive ? 'アクティブ' : '非アクティブ';
        ui.renderItemView(state.currentItem, state.currentLocation, state.parentLocation);
      } else if (state.currentLocation && state.currentLocation.pageId === pageId) {
        state.currentLocation.isActive = nextActive;
        state.currentLocation.status = nextActive ? 'アクティブ' : '非アクティブ';
        ui.renderLocationView(state.currentLocation, state.locationItems, state.subLocations, state.parentLocation);
      }
    } catch (err) {
      feedback.playError();
      ui.showToast(`ステータス更新失敗: ${err.message}`, 'error');
    } finally {
      ui.setLoading(false);
    }
  }

  /**
   * 場所起点での「編集 (一括棚卸)」スキャン処理
   */
  async _handleBatchEditScan(numericStr, isItem) {
    if (!isItem) {
      ui.showToast('一括編集では【物品】(偶数ID) をスキャンしてください', 'warning');
      feedback.playError();
      return;
    }

    const currentLoc = state.currentLocation;
    if (!currentLoc) return;

    // 現在の場所に属しているか判定
    const existingIndex = state.locationItems.findIndex(i => String(i.id) === String(numericStr));

    try {
      if (existingIndex >= 0) {
        // --- 既に存在する → 削除 (取り出し・解除) ---
        const itemToRemove = state.locationItems[existingIndex];
        await notion.updateItemLocation(itemToRemove.pageId, null);

        state.locationItems.splice(existingIndex, 1);
        feedback.playRemoved();
        ui.showToast(`「${itemToRemove.name}」を解除しました`, 'removed', 2500);
      } else {
        // --- まだ存在しない → 追加 (格納) ---
        let itemToAdd = await notion.findRecordById(numericStr, true);
        if (!itemToAdd) {
          // 未登録物品なら作成
          itemToAdd = await notion.createRecord({
            numericId: numericStr,
            name: `物品 #${numericStr}`,
            isItem: true,
            locationPageId: currentLoc.pageId
          });
        } else {
          // 既存物品の現在地をこの場所に更新
          itemToAdd = await notion.updateItemLocation(itemToAdd.pageId, currentLoc.pageId);
        }

        state.locationItems.unshift(itemToAdd);
        feedback.playAdded();
        ui.showToast(`「${itemToAdd.name}」を追加しました`, 'added', 2500);
      }

      // DOM内の物品リストを再描画（カメラは止めずに連続スキャンを維持）
      const listEl = document.getElementById('batch-item-list');
      if (listEl) {
        listEl.innerHTML = state.locationItems.length === 0
          ? '<p class="empty-text">物品がまだありません</p>'
          : state.locationItems.map(item => `
              <div class="item-card-compact" id="item-row-${item.id}">
                <div class="item-compact-info">
                  <span class="badge badge-even badge-small">物品</span>
                  <span class="item-compact-name">${item.name || '名称未設定'}</span>
                </div>
                <span class="item-compact-id">#${item.id}</span>
              </div>
            `).join('');
      }

      // 件数表示の更新
      const countEl = document.querySelector('.view-location-batch h4');
      if (countEl) {
        countEl.textContent = `棚卸・一括スキャン中: ${currentLoc.name} (${state.locationItems.length}点)`;
      }
    } catch (err) {
      ui.showToast(`更新エラー: ${err.message}`, 'error');
      feedback.playError();
    }
  }

  /**
   * 設定モーダルから設定を保存
   */
  _saveSettingsFromModal() {
    const apiKey = document.getElementById('input-api-key')?.value.trim();
    const dbId = document.getElementById('input-db-id')?.value.trim();
    const jevApiKey = document.getElementById('input-jev-api-key')?.value.trim();
    const jevMaxRaw = document.getElementById('input-jev-max-attributes')?.value;
    const jevMaxAttributes = jevMaxRaw ? Math.max(1, parseInt(jevMaxRaw, 10) || 3) : 3;

    state.saveConfig({ apiKey, dbId, jevApiKey, jevMaxAttributes, proxyMode: 'cloudflare' });
    if (apiKey && dbId) {
      notion.resolveDatabases(dbId).catch(() => {});
    }

    document.getElementById('settings-modal')?.classList.add('hidden');
    ui.showToast('設定を保存しました', 'success');

    if (state.currentMode === AppMode.HOME) {
      this.switchMode(AppMode.HOME);
    }
  }

  /**
   * 疎通テスト
   */
  async _testConnection() {
    const btn = document.getElementById('btn-test-connection');
    const statusEl = document.getElementById('connection-status-msg');
    if (!btn || !statusEl) return;

    btn.disabled = true;
    statusEl.textContent = '接続テスト中...';
    statusEl.className = 'status-text text-muted';

    const apiKey = document.getElementById('input-api-key')?.value.trim();
    const dbId = document.getElementById('input-db-id')?.value.trim();
    const jevApiKey = document.getElementById('input-jev-api-key')?.value.trim();
    const jevMaxRaw = document.getElementById('input-jev-max-attributes')?.value;
    const jevMaxAttributes = jevMaxRaw ? Math.max(1, parseInt(jevMaxRaw, 10) || 3) : 3;

    state.saveConfig({ apiKey, dbId, jevApiKey, jevMaxAttributes, proxyMode: 'cloudflare' });

    try {
      const info = await notion.testConnection();
      if (info.isDual) {
        statusEl.innerHTML = `✓ 接続成功！<br><b>物品DB</b>: 「${info.itemDb.title}」<br><b>場所DB</b>: 「${info.locationDb.title}」 (リレーション自動連携)`;
      } else {
        statusEl.textContent = `✓ 接続成功: データベース「${info.itemDb.title}」を確認しました。`;
      }
      statusEl.className = 'status-text text-success';
      feedback.playSuccess();

      const detectedEl = document.getElementById('detected-db-id');
      if (detectedEl) {
        if (info.isDual) {
          detectedEl.innerHTML = `✓ 物品DB: <code>${info.itemDb.id}</code><br>✓ 場所DB: <code>${info.locationDb.id}</code>`;
        } else {
          detectedEl.innerHTML = `✓ 接続中のID: <code>${info.itemDb.id}</code>`;
        }
      }
    } catch (err) {
      statusEl.textContent = `接続失敗: ${err.message}`;
      statusEl.className = 'status-text text-danger';
      feedback.playError();
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * Jev (TypeSafe AI) 疎通テスト
   */
  async _testJevConnection() {
    const btn = document.getElementById('btn-test-jev');
    const statusEl = document.getElementById('jev-status-msg');
    if (!btn || !statusEl) return;

    const jevApiKey = document.getElementById('input-jev-api-key')?.value.trim();
    if (!jevApiKey) {
      statusEl.textContent = 'Jev APIキーを入力してください。';
      statusEl.className = 'status-text text-warning';
      return;
    }

    btn.disabled = true;
    statusEl.textContent = 'Jev API 接続テスト中...';
    statusEl.className = 'status-text text-muted';

    try {
      const res = await JevService.testConnection(jevApiKey);
      if (res.ok) {
        statusEl.innerHTML = `✓ ${res.message}`;
        statusEl.className = 'status-text text-success';
        feedback.playSuccess();
      } else {
        statusEl.textContent = `✕ ${res.message}`;
        statusEl.className = 'status-text text-danger';
        feedback.playError();
      }
    } catch (e) {
      statusEl.textContent = `✕ エラー: ${e.message}`;
      statusEl.className = 'status-text text-danger';
      feedback.playError();
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * 別端末セットアップ用の共通URLを生成
   */
  _buildSetupUrl() {
    const { dbId, apiKey, itemDbId, locationDbId, jevApiKey, jevMaxAttributes } = state.config;
    const effectiveDbId = dbId || itemDbId;
    if (!effectiveDbId || !apiKey) {
      return null;
    }

    let targetUrl = `${window.location.origin}${window.location.pathname}?dbid=${encodeURIComponent(effectiveDbId)}&api=${encodeURIComponent(apiKey)}`;
    if (itemDbId && itemDbId !== effectiveDbId) {
      targetUrl += `&itemDbId=${encodeURIComponent(itemDbId)}`;
    }
    if (locationDbId) {
      targetUrl += `&locid=${encodeURIComponent(locationDbId)}`;
    }
    if (jevApiKey) {
      targetUrl += `&jev=${encodeURIComponent(jevApiKey)}`;
    }
    if (jevMaxAttributes) {
      targetUrl += `&jevmax=${encodeURIComponent(jevMaxAttributes)}`;
    }
    return targetUrl;
  }

  /**
   * 別端末セットアップ用URLをクリップボードにコピー
   */
  _copySetupUrl() {
    const targetUrl = this._buildSetupUrl();
    if (!targetUrl) {
      ui.showToast('先にAPIキーとデータベースIDを入力してください', 'warning');
      return;
    }

    navigator.clipboard.writeText(targetUrl).then(() => {
      ui.showToast('設定用URLをクリップボードにコピーしました！', 'success');
      feedback.playSuccess();
    }).catch(() => {
      ui.showToast('URLのコピーに失敗しました', 'error');
    });
  }

  /**
   * 別端末（スマホやWatch）セットアップ用のQRコードを生成
   */
  _generateSetupQr() {
    const targetUrl = this._buildSetupUrl();
    if (!targetUrl) {
      ui.showToast('先にAPIキーとデータベースIDを入力してください', 'warning');
      return;
    }

    const qrContainer = document.getElementById('setup-qr-preview');
    if (!qrContainer) return;

    qrContainer.innerHTML = '';

    if (window.QRCode) {
      new window.QRCode(qrContainer, {
        text: targetUrl,
        width: 180,
        height: 180,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } else {
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(targetUrl)}`;
      qrContainer.innerHTML = `<img src="${qrApiUrl}" alt="Setup QR" style="border-radius:8px; width:180px; height:180px;">`;
    }

    document.getElementById('setup-qr-wrapper')?.classList.remove('hidden');
    ui.showToast('設定用QRコードを生成しました', 'info');
  }
}

export const app = new Application();

// 起動開始
window.addEventListener('DOMContentLoaded', () => {
  app.init();
});
