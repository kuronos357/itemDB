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

class Application {
  constructor() {
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    ui.init();
    this._bindEvents();

    // 1. URLパラメータの初期判定 (?dbid=...&api=... または ?id=...)
    const handledUrl = await this._handleUrlParams();

    // 2. 該当するURLパラメータがなければホーム（待機スキャン）画面を描画
    if (!handledUrl) {
      this.switchMode(AppMode.HOME);
    }

    // 3. Web NFC をバックグラウンドで開始（対応ブラウザのみ）
    scanner.startNfc().catch(() => {});

    // 4. Service Worker登録 (PWA)
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

    scanner.addEventListener('setup-url-scanned', (e) => {
      this._applySetupConfig(e.detail.dbid, e.detail.api);
    });

    scanner.addEventListener('scan-invalid', () => {
      ui.showToast('有効なID (数字) またはURLが検出されませんでした', 'warning');
    });

    // ヘッダーナビゲーションボタン
    document.getElementById('btn-header-home')?.addEventListener('click', () => {
      this.switchMode(AppMode.HOME);
    });

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

    document.getElementById('select-proxy-mode')?.addEventListener('change', () => {
      ui._updateProxyInputVisibility();
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

      // カメラ切替
      if (e.target.closest('#btn-toggle-camera')) {
        scanner.stopCamera().then(() => scanner.startCamera('qr-reader'));
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

      // 履歴アイテムクリック
      const historyItem = e.target.closest('.history-item');
      if (historyItem) {
        const id = historyItem.dataset.id;
        if (id) this.onIdScanned(id);
        return;
      }

      // スキャンに戻る
      if (e.target.closest('#btn-back-home')) {
        this.switchMode(AppMode.HOME);
        return;
      }

      // 物品画面: 「場所変更」ボタン
      if (e.target.closest('#btn-change-location')) {
        this.switchMode(AppMode.CHANGE_LOCATION_PENDING);
        return;
      }

      // 物品画面: 現在地をクリックして場所画面へジャンプ
      const jumpLocBtn = e.target.closest('#btn-jump-location');
      if (jumpLocBtn) {
        const locId = jumpLocBtn.dataset.locId;
        if (locId) this.onIdScanned(locId);
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

      // 場所画面: 「編集 (一括棚卸)」ボタン
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

      // 場所画面: 所属物品一覧クリックで物品詳細へジャンプ
      const compactItem = e.target.closest('.item-card-compact');
      if (compactItem && state.currentMode === AppMode.LOCATION_VIEW) {
        const itemId = compactItem.dataset.itemId;
        if (itemId) this.onIdScanned(itemId);
        return;
      }
    });
  }

  /**
   * 起動時のURLクエリパラメータ処理
   */
  async _handleUrlParams() {
    const params = new URLSearchParams(window.location.search);

    // 1. 初期設定URL: ?dbid=...&api=...
    const dbid = params.get('dbid');
    const api = params.get('api');
    if (dbid && api) {
      await this._applySetupConfig(dbid, api);
      // URLから秘密トークンを除去
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
      return false; // ホームへ
    }

    // 2. ID読み込みURL: ?id=1234
    const id = params.get('id');
    if (id && /^\d+$/.test(id)) {
      await this.onIdScanned(id);
      return true;
    }

    return false;
  }

  /**
   * 初期設定の適用
   */
  async _applySetupConfig(dbid, api) {
    ui.setLoading(true, '初期設定を登録中...');
    state.saveConfig({ dbId: dbid, apiKey: api });
    try {
      const conn = await notion.testConnection();
      ui.showToast(`初期設定完了: 「${conn.title}」に接続しました`, 'success', 4000);
      feedback.playSuccess();
    } catch (err) {
      ui.showToast(`設定を保存しましたが接続確認でエラー: ${err.message}`, 'warning', 5000);
    } finally {
      ui.setLoading(false);
      this.switchMode(AppMode.HOME);
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
        if (state.isConfigured()) {
          setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
        }
        break;

      case AppMode.ITEM_VIEW:
        ui.renderItemView(state.currentItem, state.currentLocation);
        break;

      case AppMode.CHANGE_LOCATION_PENDING:
        ui.renderChangeLocationPendingView(state.currentItem);
        setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
        break;

      case AppMode.LOCATION_VIEW:
        ui.renderLocationView(state.currentLocation, state.locationItems);
        break;

      case AppMode.LOCATION_EDIT_BATCH:
        ui.renderLocationEditBatchView(state.currentLocation, state.locationItems);
        setTimeout(() => scanner.startCamera('qr-reader').catch(() => {}), 100);
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
      let record = await notion.findRecordById(numericStr);

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
        // 現在地の場所レコードを取得
        state.currentLocation = null;
        if (record.locationPageIds && record.locationPageIds.length > 0) {
          try {
            const locRes = await notion._request(`pages/${record.locationPageIds[0]}`);
            state.currentLocation = notion._normalizeRecord(locRes);
          } catch (e) {
            console.warn('[App] Could not fetch parent location:', e);
          }
        }
        await this.switchMode(AppMode.ITEM_VIEW);
      } else {
        // 場所 (Location)
        state.currentLocation = record;
        state.locationItems = await notion.queryItemsByLocation(record.pageId);
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
      let locationRecord = await notion.findRecordById(numericStr);
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

      await this.switchMode(AppMode.ITEM_VIEW);
    } catch (err) {
      ui.showToast(`移動更新エラー: ${err.message}`, 'error');
      feedback.playError();
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
        let itemToAdd = await notion.findRecordById(numericStr);
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
    const proxyMode = document.getElementById('select-proxy-mode')?.value;
    const customProxyUrl = document.getElementById('input-custom-proxy')?.value.trim();

    state.saveConfig({ apiKey, dbId, proxyMode, customProxyUrl });
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
    const proxyMode = document.getElementById('select-proxy-mode')?.value;
    const customProxyUrl = document.getElementById('input-custom-proxy')?.value.trim();

    state.saveConfig({ apiKey, dbId, proxyMode, customProxyUrl });

    try {
      const info = await notion.testConnection();
      statusEl.textContent = `接続成功: データベース「${info.title}」を確認しました。`;
      statusEl.className = 'status-text text-success';
      feedback.playSuccess();

      const detectedEl = document.getElementById('detected-db-id');
      if (detectedEl && info.id) {
        const clean = info.id.replace(/-/g, '');
        detectedEl.innerHTML = `✓ 接続中のID: <code style="color:var(--color-item);">${clean}</code>`;
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
   * 別端末（スマホやWatch）セットアップ用のQRコードを生成
   */
  _generateSetupQr() {
    const { dbId, apiKey } = state.config;
    if (!dbId || !apiKey) {
      ui.showToast('先にAPIキーとデータベースIDを入力してください', 'warning');
      return;
    }

    const targetUrl = `${window.location.origin}${window.location.pathname}?dbid=${encodeURIComponent(dbId)}&api=${encodeURIComponent(apiKey)}`;
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
