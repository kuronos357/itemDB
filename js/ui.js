/**
 * itemDB - UI Component & View Renderer
 * 
 * 画面描画、動的更新、トースト通知、テンキー入力モーダルを担当します。
 */

import { AppMode, state } from './state.js';
import { scanner } from './scanner.js';
import { feedback } from './audio.js';

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

    // ラベル・QR・NFCモーダルのイベント配線
    const labelModal = document.getElementById('label-modal');
    if (labelModal) {
      document.getElementById('btn-close-label-modal')?.addEventListener('click', () => {
        this.closeLabelModal();
      });

      const copyUrlHandler = () => {
        const url = labelModal.dataset.targetUrl;
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            this.showToast('URLをクリップボードにコピーしました', 'success');
          }).catch(() => {
            this.showToast('URLのコピーに失敗しました', 'error');
          });
        }
      };
      document.getElementById('btn-copy-label-url')?.addEventListener('click', copyUrlHandler);
      document.getElementById('btn-copy-url-nfc')?.addEventListener('click', copyUrlHandler);

      document.getElementById('btn-download-label-qr')?.addEventListener('click', () => {
        this.downloadLabelImage();
      });

      document.getElementById('btn-print-label')?.addEventListener('click', () => {
        window.print();
      });

      document.getElementById('btn-write-nfc')?.addEventListener('click', () => {
        this.startNfcWrite();
      });

      document.getElementById('btn-cancel-nfc')?.addEventListener('click', () => {
        this.cancelNfcWrite();
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
        <p class="text-sub">下のカメラで設定用QRコード（またはAPIキー）を読み取るか、手動で入力してください。</p>
        <button id="btn-open-settings" class="btn btn-primary mt-2">設定を手動で入力</button>
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
            <p class="guide-label">${isConfigured ? 'QRコードまたはNFCを読み取り' : '設定QRコードをカメラに向けてください'}</p>
          </div>
        </div>

        <div class="quick-actions">
          <button id="btn-manual-id" class="btn btn-secondary action-btn">
            <span class="btn-icon">🔢</span>
            <span>テンキー入力</span>
          </button>
          <button id="btn-toggle-camera" class="btn btn-secondary action-btn">
            <span class="btn-icon">${scanner.getCameraState() === 'off' ? '📷' : (scanner.getCameraState() === 'user' ? '⏹️' : '🔄')}</span>
            <span>${scanner.getCameraState() === 'off' ? 'カメラ起動' : (scanner.getCameraState() === 'user' ? 'カメラ停止' : '前面カメラ')}</span>
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

            <!-- ステータス・アクティブ制御 -->
            <div class="prop-item highlight-status">
              <span class="prop-label">ステータス</span>
              <div class="prop-val-row space-between">
                <span class="badge ${item.isActive === false ? 'badge-inactive' : 'badge-active'}">
                  ${item.isActive === false ? '⚪ 非アクティブ' : '🟢 アクティブ'}
                </span>
                <button id="btn-toggle-active" class="btn btn-sm ${item.isActive === false ? 'btn-outline-active' : 'btn-outline-inactive'}" data-page-id="${item.pageId}" data-is-active="${item.isActive === false ? 'false' : 'true'}" title="ステータスを切り替える">
                  ${item.isActive === false ? '🟢 有効化 (アクティブ)' : '⚪ 非アクティブ化'}
                </button>
              </div>
            </div>

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
            <button id="btn-open-label-modal" class="btn btn-secondary">
              <span class="btn-icon">🏷️</span>
              <span>ラベル・QR</span>
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

          ${location.isActive !== null ? `
            <div class="prop-item mt-2">
              <div class="prop-val-row space-between">
                <span class="badge ${location.isActive === false ? 'badge-inactive' : 'badge-active'}">
                  ${location.isActive === false ? '⚪ 非アクティブ' : '🟢 アクティブ'}
                </span>
                <button id="btn-toggle-active" class="btn btn-sm ${location.isActive === false ? 'btn-outline-active' : 'btn-outline-inactive'}" data-page-id="${location.pageId}" data-is-active="${location.isActive === false ? 'false' : 'true'}" title="場所のステータスを切り替える">
                  ${location.isActive === false ? '🟢 有効化' : '⚪ 非アクティブ化'}
                </button>
              </div>
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
            <button id="btn-open-label-modal" class="btn btn-secondary">
              <span class="btn-icon">🏷️</span>
              <span>ラベル・QR</span>
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
                  <a href="?id=${item.id}" class="item-card-compact ${item.isActive === false ? 'item-inactive' : ''}" data-item-id="${item.id}">
                    <div class="item-compact-info">
                      <span class="badge ${item.isActive === false ? 'badge-inactive-sm' : 'badge-even'} badge-small">
                        ${item.isActive === false ? '非アクティブ' : '物品'}
                      </span>
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

  /**
   * カメラ状態に応じたUI（ボタン表記、ビューファインダーのプレースホルダー）更新
   * @param {'environment' | 'user' | 'off'} cameraState 
   */
  updateCameraStateUI(cameraState) {
    const toggleBtn = document.getElementById('btn-toggle-camera');
    const qrReaderEl = document.getElementById('qr-reader');
    const guideLabel = document.querySelector('.guide-label');

    if (toggleBtn) {
      if (cameraState === 'environment') {
        toggleBtn.innerHTML = `<span class="btn-icon">🔄</span><span>前面カメラ</span>`;
        toggleBtn.title = '前面カメラに切り替え';
      } else if (cameraState === 'user') {
        toggleBtn.innerHTML = `<span class="btn-icon">⏹️</span><span>カメラ停止</span>`;
        toggleBtn.title = 'カメラを停止';
      } else {
        toggleBtn.innerHTML = `<span class="btn-icon">📷</span><span>カメラ起動</span>`;
        toggleBtn.title = '背面カメラを起動';
      }
    }

    if (qrReaderEl) {
      const existingPlaceholder = document.getElementById('camera-off-placeholder');
      if (cameraState === 'off') {
        if (!existingPlaceholder) {
          const placeholder = document.createElement('div');
          placeholder.id = 'camera-off-placeholder';
          placeholder.className = 'camera-off-placeholder';
          placeholder.innerHTML = `
            <div class="camera-off-icon">📷</div>
            <div class="camera-off-text">カメラは停止中です</div>
            <div class="camera-off-sub">タップしてカメラを起動</div>
          `;
          placeholder.addEventListener('click', () => {
            scanner.cycleCamera('qr-reader').catch(() => {});
          });
          qrReaderEl.appendChild(placeholder);
        }
        if (guideLabel) {
          guideLabel.textContent = 'カメラ停止中 (テンキー入力またはタップで起動)';
        }
      } else {
        if (existingPlaceholder) {
          existingPlaceholder.remove();
        }
        if (guideLabel && state.isConfigured()) {
          guideLabel.textContent = 'QRコードまたはNFCを読み取り';
        }
      }
    }
  }

  /**
   * ラベル・QR・NFC発行モーダルの表示・生成
   */
  renderLabelModal(itemOrLocation, type = 'item') {
    const modal = document.getElementById('label-modal');
    if (!modal || !itemOrLocation) return;

    const isItem = (type === 'item');
    const badgeEl = document.getElementById('label-modal-badge');
    const idTagEl = document.getElementById('label-modal-id-tag');
    const nameEl = document.getElementById('label-modal-name');
    const urlEl = document.getElementById('label-modal-url');
    const qrContainer = document.getElementById('label-modal-qr-container');

    if (badgeEl) {
      badgeEl.className = `badge ${isItem ? 'badge-even' : 'badge-odd'}`;
      badgeEl.textContent = isItem ? '物品 (偶数ID)' : '場所 (奇数ID)';
    }
    if (idTagEl) idTagEl.textContent = `#${itemOrLocation.id}`;
    if (nameEl) nameEl.textContent = itemOrLocation.name || '名称未設定';

    const baseUrl = window.location.origin + window.location.pathname;
    const targetUrl = `${baseUrl.replace(/\/index\.html$/, '/')}?id=${itemOrLocation.id}`;
    if (urlEl) urlEl.textContent = targetUrl;

    if (qrContainer) {
      qrContainer.innerHTML = '';
      if (window.QRCode) {
        new window.QRCode(qrContainer, {
          text: targetUrl,
          width: 180,
          height: 180,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.H
        });
      }
    }

    const supportedBox = document.getElementById('nfc-write-supported-box');
    const unsupportedBox = document.getElementById('nfc-write-unsupported-box');
    const statusBox = document.getElementById('nfc-write-status');
    const writeBtn = document.getElementById('btn-write-nfc');

    if (statusBox) statusBox.classList.add('hidden');
    if (writeBtn) writeBtn.disabled = false;

    if (scanner.isNfcSupported()) {
      if (supportedBox) supportedBox.classList.remove('hidden');
      if (unsupportedBox) unsupportedBox.classList.add('hidden');
    } else {
      if (supportedBox) supportedBox.classList.add('hidden');
      if (unsupportedBox) unsupportedBox.classList.remove('hidden');
    }

    modal.dataset.targetUrl = targetUrl;
    modal.dataset.itemId = itemOrLocation.id;
    modal.dataset.itemName = itemOrLocation.name || `ID_${itemOrLocation.id}`;
    modal.dataset.itemType = type;

    modal.classList.remove('hidden');
  }

  closeLabelModal() {
    const modal = document.getElementById('label-modal');
    if (modal) {
      modal.classList.add('hidden');
      this.cancelNfcWrite();
    }
  }

  downloadLabelImage() {
    const modal = document.getElementById('label-modal');
    const id = modal?.dataset.itemId || 'item';
    const name = modal?.dataset.itemName || '';
    const type = modal?.dataset.itemType || 'item';
    const qrCanvas = document.querySelector('#label-modal-qr-container canvas');

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const width = 400;
    const height = 520;
    canvas.width = width;
    canvas.height = height;

    // 背景（白）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    // 外枠
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 3;
    ctx.strokeRect(10, 10, width - 20, height - 20);

    // ヘッダー（バッジ・ID）
    ctx.fillStyle = type === 'item' ? '#38bdf8' : '#fb923c';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(24, 24, 110, 32, 6);
      ctx.fill();
    } else {
      ctx.fillRect(24, 24, 110, 32);
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(type === 'item' ? '物品 (Even)' : '場所 (Odd)', 79, 46);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`#${id}`, width - 24, 48);

    // アイテム名
    ctx.font = 'bold 19px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0f172a';
    let displayName = name;
    if (displayName.length > 18) displayName = displayName.slice(0, 17) + '…';
    ctx.fillText(displayName, width / 2, 92);

    // QRコード描画
    if (qrCanvas) {
      const qrSize = 260;
      ctx.drawImage(qrCanvas, (width - qrSize) / 2, 115, qrSize, qrSize);
    }

    // URLテキスト
    ctx.font = '12px monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    const url = modal?.dataset.targetUrl || `https://itemdb.pages.dev/?id=${id}`;
    ctx.fillText(url, width / 2, 410);

    // itemDB フッター
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('itemDB Logistics & Cache', width / 2, 450);

    // PNGダウンロード実行
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `itemDB_${type}_${id}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.showToast('ラベル画像を保存しました', 'success');
  }

  async startNfcWrite() {
    const modal = document.getElementById('label-modal');
    const url = modal?.dataset.targetUrl;
    if (!url) return;

    const statusBox = document.getElementById('nfc-write-status');
    const msgEl = document.getElementById('nfc-status-msg');
    const writeBtn = document.getElementById('btn-write-nfc');

    if (this.nfcAbortController) {
      this.nfcAbortController.abort();
    }
    this.nfcAbortController = new AbortController();

    if (statusBox) statusBox.classList.remove('hidden');
    if (writeBtn) writeBtn.disabled = true;
    if (msgEl) msgEl.textContent = 'スマートフォンの背面にNFCタグをかざしてください...';

    try {
      await scanner.writeNfc(url, this.nfcAbortController.signal);
      feedback.playSuccess();
      this.showToast('NFCタグへの書き込みが完了しました！', 'success');
      if (msgEl) msgEl.innerHTML = '<span style="color:#4ade80;">✓ 書き込みが完了しました！</span>';
      setTimeout(() => {
        if (statusBox) statusBox.classList.add('hidden');
        if (writeBtn) writeBtn.disabled = false;
      }, 2000);
    } catch (err) {
      if (err.name === 'AbortError') {
        this.showToast('NFC書き込みをキャンセルしました', 'info');
      } else {
        feedback.playError();
        this.showToast(`NFC書き込み失敗: ${err.message}`, 'error');
        if (msgEl) msgEl.innerHTML = `<span style="color:#f87171;">エラー: ${err.message}</span>`;
      }
      if (statusBox) statusBox.classList.add('hidden');
      if (writeBtn) writeBtn.disabled = false;
    } finally {
      this.nfcAbortController = null;
    }
  }

  cancelNfcWrite() {
    if (this.nfcAbortController) {
      this.nfcAbortController.abort();
      this.nfcAbortController = null;
    }
    const statusBox = document.getElementById('nfc-write-status');
    const writeBtn = document.getElementById('btn-write-nfc');
    if (statusBox) statusBox.classList.add('hidden');
    if (writeBtn) writeBtn.disabled = false;
  }
}

export const ui = new UIManager();
