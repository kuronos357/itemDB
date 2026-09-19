/**
 * itemDB - UI Component & View Renderer
 * 
 * 画面描画、動的更新、トースト通知、テンキー入力モーダルを担当します。
 */

import { AppMode, state } from './state.js';

class UIManager {
  constructor() {
    this.container = null;
    this.toastContainer = null;
    this.keypadCallback = null;
  }

  init() {
    this.container = document.getElementById('app-main');
    this.toastContainer = document.getElementById('toast-container');
    this._bindGlobalEvents();
  }

  _bindGlobalEvents() {
    // テンキーモーダルのボタン配線
    const keypad = document.getElementById('keypad-modal');
    if (keypad) {
      keypad.querySelectorAll('.num-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const val = e.currentTarget.dataset.val;
          const input = document.getElementById('keypad-input');
          if (!input) return;
          if (val === 'clear') {
            input.value = '';
          } else if (val === 'backspace') {
            input.value = input.value.slice(0, -1);
          } else {
            input.value += val;
          }
        });
      });

      document.getElementById('keypad-submit')?.addEventListener('click', () => {
        const input = document.getElementById('keypad-input');
        const val = input?.value.trim();
        this.closeKeypad();
        if (val && this.keypadCallback) {
          this.keypadCallback(val);
        }
      });

      document.getElementById('keypad-close')?.addEventListener('click', () => {
        this.closeKeypad();
      });
    }
  }

  showToast(message, type = 'info', duration = 3000) {
    if (!this.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type} fade-in`;
    toast.innerHTML = `
      <span class="toast-icon">${this._getToastIcon(type)}</span>
      <span class="toast-text">${message}</span>
    `;
    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  _getToastIcon(type) {
    switch (type) {
      case 'success': return '✓';
      case 'warning': return '⚠';
      case 'error': return '✕';
      case 'added': return '＋';
      case 'removed': return 'ー';
      default: return 'ℹ';
    }
  }

  openKeypad(title = 'ID手動入力', initialVal = '', callback) {
    this.keypadCallback = callback;
    const modal = document.getElementById('keypad-modal');
    const input = document.getElementById('keypad-input');
    const titleEl = document.getElementById('keypad-title');
    if (modal && input) {
      if (titleEl) titleEl.textContent = title;
      input.value = initialVal;
      modal.classList.remove('hidden');
    }
  }

  closeKeypad() {
    const modal = document.getElementById('keypad-modal');
    if (modal) modal.classList.add('hidden');
    this.keypadCallback = null;
  }

  /**
   * 未設定時の案内バナー描画
   */
  renderUnconfiguredBanner() {
    return `
      <div class="card warning-card">
        <div class="card-header">
          <span class="icon">⚠</span>
          <h3>初期設定が必要です</h3>
        </div>
        <p>Notion APIキーとデータベースIDがまだ登録されていません。</p>
        <p class="text-sub">設定用QRコードを読み取るか、右上の歯車アイコンから手動入力してください。</p>
        <button id="btn-open-settings" class="btn btn-primary mt-2">設定を開く</button>
      </div>
    `;
  }

  /**
   * ホーム・待機画面の描画
   */
  renderHomeView() {
    const isConfigured = state.isConfigured();
    const historyList = state.history.slice(0, 5);

    let html = `
      <div class="view-home">
        ${!isConfigured ? this.renderUnconfiguredBanner() : ''}

        <div class="scanner-wrapper">
          <div id="qr-reader" class="scanner-viewport"></div>
          <div class="scanner-guide">
            <div class="guide-frame">
              <span class="corner tl"></span>
              <span class="corner tr"></span>
              <span class="corner bl"></span>
              <span class="corner br"></span>
              <div class="laser-line"></div>
            </div>
            <p class="guide-label">QRコードまたはNFCを読み取り</p>
          </div>
        </div>

        <div class="quick-actions">
          <button id="btn-manual-id" class="btn btn-secondary action-btn">
            <span class="btn-icon">🔢</span>
            <span>テンキー入力</span>
          </button>
          <button id="btn-toggle-camera" class="btn btn-secondary action-btn">
            <span class="btn-icon">📷</span>
            <span>カメラ切替</span>
          </button>
        </div>

        <div class="card history-card mt-3">
          <div class="card-header space-between">
            <h4>最近スキャンしたアイテム</h4>
            ${state.history.length > 0 ? '<button id="btn-clear-history" class="btn-text">消去</button>' : ''}
          </div>
          ${historyList.length === 0 ? '<p class="empty-text">履歴はありません</p>' : ''}
          <div class="history-list">
            ${historyList.map(h => `
              <a href="?id=${h.id}" class="history-item" data-id="${h.id}">
                <span class="badge ${h.type === 'item' ? 'badge-even' : 'badge-odd'}">${h.type === 'item' ? '物品' : '場所'}</span>
                <span class="history-name">${h.name || '名称未設定'}</span>
                <span class="history-id">#${h.id}</span>
              </a>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    this.container.innerHTML = html;
  }

  /**
   * 物品詳細画面の描画 (Even ID)
   */
  renderItemView(item, locationRecord = null, parentLocation = null) {
    let locationDisplayName = '未配置';
    if (locationRecord) {
      if (parentLocation) {
        locationDisplayName = `${parentLocation.name} ＞ ${locationRecord.name}`;
      } else {
        locationDisplayName = locationRecord.name;
      }
    } else if (item.locationPageIds && item.locationPageIds.length > 0) {
      locationDisplayName = '場所ID確認中...';
    }
    const locationId = locationRecord?.id;

    let html = `
      <div class="view-item-detail">
        <div class="breadcrumb">
          <a href="./" id="btn-back-home" class="btn-link">← スキャンに戻る</a>
        </div>

        <div class="card detail-card">
          <div class="detail-badge-row">
            <span class="badge badge-even">物品 (偶数ID)</span>
            <span class="id-tag">#${item.id}</span>
          </div>

          <h2 class="detail-title">${item.name || '名称未設定'}</h2>

          <div class="property-grid mt-3">
            <div class="prop-item highlight-prop">
              <span class="prop-label">現在地 (物理アドレス)</span>
              <div class="prop-val-row">
                <span class="prop-value location-val">${locationDisplayName}</span>
                ${locationId ? `<a href="?id=${locationId}" class="btn-text btn-jump-link" id="btn-jump-location" data-loc-id="${locationId}">場所を見る →</a>` : ''}
              </div>
            </div>

            ${item.attributes && item.attributes.length > 0 ? `
              <div class="prop-item">
                <span class="prop-label">属性</span>
                <div class="prop-tags">
                  ${item.attributes.map(a => `<span class="badge badge-tag">${a}</span>`).join('')}
                </div>
              </div>
            ` : ''}

            ${item.status ? `
              <div class="prop-item">
                <span class="prop-label">状態</span>
                <span class="prop-value">${item.status}</span>
              </div>
            ` : ''}

            ${item.notes && (!item.attributes || item.notes !== item.attributes.join(' / ')) ? `
              <div class="prop-item">
                <span class="prop-label">メモ</span>
                <span class="prop-value">${item.notes}</span>
              </div>
            ` : ''}
          </div>

          <div class="action-buttons mt-4">
            <button id="btn-change-location" class="btn btn-primary btn-large">
              <span class="btn-icon">📍</span>
              <span>場所変更</span>
            </button>
            ${item.url ? `
              <a href="${item.url}" target="_blank" rel="noopener" class="btn btn-outline">
                <span>Notionで開く ↗</span>
              </a>
            ` : ''}
          </div>
        </div>
      </div>
    `;
    this.container.innerHTML = html;
  }

  /**
   * 物品の場所変更待ち画面 (Change Location Pending)
   */
  renderChangeLocationPendingView(item) {
    let html = `
      <div class="view-pending-move">
        <div class="banner pending-banner">
          <div class="banner-icon">📍</div>
          <div class="banner-body">
            <h4>移動先の【場所】をスキャンしてください</h4>
            <p>対象物品: <strong>${item.name || `#${item.id}`}</strong></p>
            <p class="text-sub">場所タグ (奇数ID) のQRコードまたはNFCを読み取ると即座に更新されます。</p>
          </div>
        </div>

        <div class="scanner-wrapper mt-2">
          <div id="qr-reader" class="scanner-viewport"></div>
          <div class="scanner-guide">
            <div class="guide-frame">
              <span class="corner tl"></span>
              <span class="corner tr"></span>
              <span class="corner bl"></span>
              <span class="corner br"></span>
              <div class="laser-line"></div>
            </div>
            <p class="guide-label">場所QRコードをスキャン</p>
          </div>
        </div>

        <div class="action-buttons mt-3">
          <button id="btn-manual-location-id" class="btn btn-secondary">
            <span>場所IDを手入力</span>
          </button>
          <button id="btn-cancel-pending" class="btn btn-outline">
            <span>キャンセル</span>
          </button>
        </div>
      </div>
    `;
    this.container.innerHTML = html;
  }

  /**
   * 場所詳細画面の描画 (Odd ID)
   */
  renderLocationView(location, items = [], subLocations = [], parentLocation = null) {
    let html = `
      <div class="view-location-detail">
        <div class="breadcrumb space-between">
          <a href="./" id="btn-back-home" class="btn-link">← スキャンに戻る</a>
          ${parentLocation ? `
            <a href="?id=${parentLocation.id}" class="btn-link parent-link" id="btn-jump-parent" data-loc-id="${parentLocation.id}">
              📂 上位: ${parentLocation.name || `#${parentLocation.id}`}
            </a>
          ` : ''}
        </div>

        <div class="card detail-card">
          <div class="detail-badge-row">
            <span class="badge badge-odd">場所 (奇数ID)</span>
            <span class="id-tag">#${location.id}</span>
          </div>

          <h2 class="detail-title">${location.name || '名称未設定'}</h2>

          ${location.attributes && location.attributes.length > 0 ? `
            <div class="prop-tags mt-2">
              ${location.attributes.map(a => `<span class="badge badge-tag">${a}</span>`).join('')}
            </div>
          ` : ''}

          <div class="action-buttons mt-3 mb-3">
            <button id="btn-add-item-to-location" class="btn btn-primary btn-large">
              <span class="btn-icon">➕</span>
              <span>物品を追加</span>
            </button>
            <button id="btn-edit-batch" class="btn btn-secondary">
              <span class="btn-icon">⚡</span>
              <span>一括棚卸</span>
            </button>
            ${location.url ? `
              <a href="${location.url}" target="_blank" rel="noopener" class="btn btn-outline">
                <span>Notion ↗</span>
              </a>
            ` : ''}
          </div>

          ${subLocations && subLocations.length > 0 ? `
            <div class="sublocation-section mt-3 mb-3">
              <div class="section-header">
                <h4>📂 収納スペース・段一覧 (${subLocations.length}箇所)</h4>
              </div>
              <div class="sublocation-grid mt-2">
                ${subLocations.map(sub => `
                  <a href="?id=${sub.id}" class="sublocation-card" data-sub-id="${sub.id}">
                    <div class="sublocation-card-info">
                      <span class="badge badge-odd badge-small">場所</span>
                      <span class="sublocation-name">${sub.name || '名称未設定'}</span>
                    </div>
                    <div class="sublocation-card-action">
                      <span class="item-compact-id">#${sub.id}</span>
                      <span class="btn-text btn-jump-sub">開く →</span>
                    </div>
                  </a>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <div class="location-items-section mt-3">
            <div class="section-header space-between">
              <h3>置いてあるもの一覧 (${items.length}点)</h3>
            </div>

            ${items.length === 0 ? `
              <div class="empty-state">
                <p>現在この場所に登録されている物品はありません。</p>
                <p class="text-sub">上の「➕ 物品を追加」または「⚡ 一括棚卸」から物品を指定できます。</p>
              </div>
            ` : `
              <div class="item-list">
                ${items.map(item => `
                  <a href="?id=${item.id}" class="item-card-compact" data-item-id="${item.id}">
                    <div class="item-compact-info">
                      <span class="badge badge-even badge-small">物品</span>
                      <span class="item-compact-name">${item.name || '名称未設定'}</span>
                      ${item.attributes && item.attributes.length > 0 ? `<span class="badge badge-tag badge-small">${item.attributes[0]}</span>` : ''}
                    </div>
                    <div class="item-compact-actions">
                      <span class="item-compact-id">#${item.id}</span>
                      <button type="button" class="btn-text text-danger btn-unlink-item" data-item-page-id="${item.pageId}" data-item-name="${item.name || item.id}" title="この場所から解除">解除</button>
                    </div>
                  </a>
                `).join('')}
              </div>
            `}
          </div>
        </div>
      </div>
    `;
    this.container.innerHTML = html;
  }

  /**
   * 場所起点の一括編集モード画面 (Batch Edit)
   */
  renderLocationEditBatchView(location, items = []) {
    let html = `
      <div class="view-location-batch">
        <div class="banner batch-banner">
          <div class="banner-icon">⚡</div>
          <div class="banner-body">
            <h4>棚卸・一括スキャン中: ${location.name}</h4>
            <p>物品 (偶数ID) を連続してスキャンしてください。</p>
            <p class="text-sub">
              ・一覧にある物品 → <span class="text-warn">削除 (取り出し)</span><br>
              ・一覧にない物品 → <span class="text-success">追加 (格納)</span>
            </p>
          </div>
        </div>

        <div class="scanner-wrapper mt-2">
          <div id="qr-reader" class="scanner-viewport"></div>
          <div class="scanner-guide">
            <div class="guide-frame">
              <span class="corner tl"></span>
              <span class="corner tr"></span>
              <span class="corner bl"></span>
              <span class="corner br"></span>
              <div class="laser-line"></div>
            </div>
            <p class="guide-label">物品QRコードを次々にスキャン</p>
          </div>
        </div>

        <div class="batch-controls mt-2">
          <button id="btn-manual-batch-item" class="btn btn-secondary">
            <span>物品ID手入力</span>
          </button>
          <button id="btn-finish-batch" class="btn btn-primary">
            <span>編集完了</span>
          </button>
        </div>

        <div class="card mt-3">
          <h4>現在の保管物品 (${items.length}点)</h4>
          <div id="batch-item-list" class="item-list mt-2">
            ${items.length === 0 ? '<p class="empty-text">物品がまだありません</p>' : ''}
            ${items.map(item => `
              <div class="item-card-compact" id="item-row-${item.id}">
                <div class="item-compact-info">
                  <span class="badge badge-even badge-small">物品</span>
                  <span class="item-compact-name">${item.name || '名称未設定'}</span>
                </div>
                <span class="item-compact-id">#${item.id}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
    this.container.innerHTML = html;
  }

  /**
   * 設定モーダルの表示・初期化
   */
  renderSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    const { apiKey, dbId, proxyMode, customProxyUrl } = state.config;

    document.getElementById('input-api-key').value = apiKey || '';
    document.getElementById('input-db-id').value = dbId || '';
    document.getElementById('select-proxy-mode').value = proxyMode || 'auto';
    document.getElementById('input-custom-proxy').value = customProxyUrl || '';

    this._updateProxyInputVisibility();

    const detectedEl = document.getElementById('detected-db-id');
    if (detectedEl) {
      const { itemDbId, locationDbId, itemDbTitle, locationDbTitle, dbId: rawDbId } = state.config;
      if (itemDbId && locationDbId && itemDbId !== locationDbId) {
        detectedEl.innerHTML = `✓ 連携中: <b>物品DB</b>「${itemDbTitle || itemDbId.slice(0, 8)}」⇄ <b>場所DB</b>「${locationDbTitle || locationDbId.slice(0, 8)}」`;
      } else if (itemDbId || rawDbId) {
        detectedEl.innerHTML = `✓ 接続中のID: <code>${itemDbId || rawDbId}</code>`;
      } else {
        detectedEl.textContent = '物品DBまたは場所DBのURLを貼り付けると、リレーションからもう片方のDBも自動判別・連携されます。';
      }
    }

    modal.classList.remove('hidden');
  }

  _updateProxyInputVisibility() {
    const mode = document.getElementById('select-proxy-mode')?.value;
    const customGroup = document.getElementById('custom-proxy-group');
    if (customGroup) {
      if (mode === 'custom') {
        customGroup.classList.remove('hidden');
      } else {
        customGroup.classList.add('hidden');
      }
    }
  }

  setLoading(isLoading, text = '処理中...') {
    const loader = document.getElementById('global-loader');
    const loaderText = document.getElementById('loader-text');
    if (!loader) return;
    if (isLoading) {
      if (loaderText) loaderText.textContent = text;
      loader.classList.remove('hidden');
    } else {
      loader.classList.add('hidden');
    }
  }
}

export const ui = new UIManager();
