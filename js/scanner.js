/**
 * itemDB - Scanner & NFC Integration
 * 
 * カメラによるQRコード読み取り (html5-qrcode)、
 * Web NFC API (NDEFReader) によるタグ読み取り、
 * URL解析とID抽出を担当します。
 */

import { state } from './state.js';
import { feedback } from './audio.js';
import { NotionClient } from './notion.js';
import { BarcodeService } from './barcode.js';

class ScannerService extends EventTarget {
  constructor() {
    super();
    this.html5QrCode = null;
    this.isScanning = false;
    this.lastScannedText = null;
    this.lastScannedTime = 0;
    this.nfcReader = null;
    this.isNfcActive = false;
    this.cameraFacingMode = 'environment'; // 'environment' | 'user'
    this.cameraEnabled = true;             // ユーザーのカメラON/OFF状態
    this.currentElementId = 'qr-reader';
  }

  /**
   * 現在のカメラ状態を取得 ('environment' | 'user' | 'off')
   */
  getCameraState() {
    if (!this.cameraEnabled || !this.isScanning) {
      return 'off';
    }
    return this.cameraFacingMode;
  }

  /**
   * QR / NFC / テキストから数字IDを抽出
   * サポート形式:
   *  - https://kuronos357.github.io/itemDB/?id=1234
   *  - https://example.com/scan?id=1234
   *  - https://example.com/i/1234, /l/1234
   *  - 1234 (純粋な数字文字列)
   */
  parseInputToId(raw) {
    if (!raw) return null;
    const str = String(raw).trim();

    // 1. 純粋な数字
    if (/^\d+$/.test(str)) {
      return str;
    }

    // 2. URL形式
    try {
      const url = new URL(str, window.location.origin);

      // クエリパラメータ ?id=...
      const queryId = url.searchParams.get('id');
      if (queryId && /^\d+$/.test(queryId)) {
        return queryId;
      }

      // パス末尾の数字 /item/1234, /l/1234
      const segments = url.pathname.split('/').filter(Boolean);
      const lastSegment = segments[segments.length - 1];
      if (lastSegment && /^\d+$/.test(lastSegment)) {
        return lastSegment;
      }
    } catch {
      // URLパース失敗時は正規表現でフォールバック
    }

    const match = str.match(/(?:[?&]id=|\/)(\d+)(?:[&#]|$)/);
    return match ? match[1] : null;
  }

  /**
   * カメラの切り替えサイクル (背面 -> 前面 -> OFF -> 背面)
   */
  async cycleCamera(elementId = 'qr-reader') {
    this.currentElementId = elementId;

    if (!this.cameraEnabled || !this.isScanning) {
      // OFF状態 -> 背面カメラ起動
      this.cameraEnabled = true;
      this.cameraFacingMode = 'environment';
      await this.startCamera(elementId);
    } else if (this.cameraFacingMode === 'environment') {
      // 背面カメラ -> 前面カメラへ切替
      this.cameraFacingMode = 'user';
      await this.stopCamera();
      await this.startCamera(elementId);
    } else {
      // 前面カメラ -> カメラOFFへ
      this.cameraEnabled = false;
      await this.stopCamera();
    }

    const nextState = this.getCameraState();
    this.dispatchEvent(new CustomEvent('camera-state-changed', {
      detail: { state: nextState, facingMode: this.cameraFacingMode, enabled: this.cameraEnabled }
    }));
    return nextState;
  }

  /**
   * カメラQRスキャナの初期化・起動
   */
  async startCamera(elementId = 'qr-reader') {
    this.currentElementId = elementId;
    if (!this.cameraEnabled) {
      // ユーザーが意図的にOFFにしている場合は起動しない
      return;
    }
    if (this.isScanning) return;

    if (!window.Html5Qrcode) {
      console.warn('[Scanner] Html5Qrcode library not loaded.');
      return;
    }

    try {
      const formatsToSupport = window.Html5QrcodeSupportedFormats ? [
        window.Html5QrcodeSupportedFormats.QR_CODE,
        window.Html5QrcodeSupportedFormats.EAN_13,
        window.Html5QrcodeSupportedFormats.EAN_8,
        window.Html5QrcodeSupportedFormats.UPC_A,
        window.Html5QrcodeSupportedFormats.UPC_E,
        window.Html5QrcodeSupportedFormats.CODE_128
      ] : undefined;

      this.html5QrCode = new window.Html5Qrcode(
        elementId,
        formatsToSupport ? { formatsToSupport, verbose: false } : false
      );

      const config = {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const width = Math.min(viewfinderWidth * 0.85, 320);
          const height = Math.min(viewfinderHeight * 0.6, 220);
          return { width: Math.floor(width), height: Math.floor(height) };
        },
        aspectRatio: 1.0,
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true
        }
      };

      await this.html5QrCode.start(
        { facingMode: this.cameraFacingMode },
        config,
        (decodedText) => this._onScanSuccess(decodedText),
        () => {} // スキャン途中のフレームミスは無視
      );

      this.isScanning = true;
      this.dispatchEvent(new CustomEvent('scanner-started', {
        detail: { facingMode: this.cameraFacingMode }
      }));
      this.dispatchEvent(new CustomEvent('camera-state-changed', {
        detail: { state: this.cameraFacingMode, facingMode: this.cameraFacingMode, enabled: true }
      }));
    } catch (err) {
      console.error('[Scanner] Failed to start camera:', err);
      this.dispatchEvent(new CustomEvent('scanner-error', { detail: err }));
      throw err;
    }
  }

  /**
   * カメラQRスキャナ停止
   */
  async stopCamera() {
    if (!this.isScanning || !this.html5QrCode) return;

    try {
      await this.html5QrCode.stop();
      this.html5QrCode.clear();
      this.html5QrCode = null;
      this.isScanning = false;
      this.dispatchEvent(new CustomEvent('scanner-stopped'));
      this.dispatchEvent(new CustomEvent('camera-state-changed', {
        detail: { state: this.getCameraState(), facingMode: this.cameraFacingMode, enabled: this.cameraEnabled }
      }));
    } catch (err) {
      console.error('[Scanner] Error stopping camera:', err);
    }
  }

  _onScanSuccess(decodedText) {
    const now = Date.now();
    // 連続重複スキャンのデバウンス (1.2秒以内の同一コードは無視)
    if (decodedText === this.lastScannedText && (now - this.lastScannedTime) < 1200) {
      return;
    }

    this.lastScannedText = decodedText;
    this.lastScannedTime = now;

    // 設定用QRコード（URL、APIキー、DB ID、JSON等）の検知
    if (this._checkSetupConfig(decodedText)) {
      feedback.playScan();
      return;
    }

    // バーコード（JAN/ISBNコード）の検知 (8桁, 12桁, 13桁, 10桁ISBN等)
    if (BarcodeService.isBarcode(decodedText)) {
      feedback.playScan();
      this.dispatchEvent(new CustomEvent('barcode-scanned', {
        detail: {
          code: decodedText.trim(),
          raw: decodedText
        }
      }));
      return;
    }

    const id = this.parseInputToId(decodedText);
    if (!id) {
      feedback.playError();
      this.dispatchEvent(new CustomEvent('scan-invalid', { detail: decodedText }));
      return;
    }

    feedback.playScan();
    this.dispatchEvent(new CustomEvent('scan-success', {
      detail: {
        raw: decodedText,
        id,
        parsedId: state.constructor.parseId(id)
      }
    }));
  }

  /**
   * 設定用QRコード（URL、APIキー、データベースID、JSON等）の検知・抽出
   */
  _checkSetupConfig(text) {
    if (!text || typeof text !== 'string') return false;
    const str = text.trim();

    // 1. JSON形式の検出: {"apiKey":"...", "dbId":"..."} 等
    if (str.startsWith('{') && str.endsWith('}')) {
      try {
        const json = JSON.parse(str);
        if (json && typeof json === 'object') {
          const apiKey = json.apiKey || json.api || json.api_key || json.key || json.token || json.secret;
          const dbId = json.dbId || json.db || json.db_id || json.databaseId || json.database_id || json.dbid;
          const itemDbId = json.itemDbId || json.item_db_id;
          const locationDbId = json.locationDbId || json.location_db_id || json.locid;
          const proxyMode = json.proxyMode || json.proxy;
          const customProxyUrl = json.customProxyUrl || json.proxyUrl;
          const jevApiKey = json.jevApiKey || json.jev || json.jev_api_key;
          const jevMaxAttributes = json.jevMaxAttributes || json.jevmax || json.jev_max;

          if (apiKey || dbId || itemDbId || locationDbId || jevApiKey || jevMaxAttributes) {
            const detail = {};
            if (apiKey) detail.apiKey = String(apiKey).trim();
            if (dbId) detail.dbId = String(dbId).trim();
            if (itemDbId) detail.itemDbId = String(itemDbId).trim();
            if (locationDbId) detail.locationDbId = String(locationDbId).trim();
            if (proxyMode) detail.proxyMode = String(proxyMode).trim();
            if (customProxyUrl) detail.customProxyUrl = String(customProxyUrl).trim();
            if (jevApiKey) detail.jevApiKey = String(jevApiKey).trim();
            if (jevMaxAttributes) detail.jevMaxAttributes = parseInt(jevMaxAttributes, 10);

            this.dispatchEvent(new CustomEvent('setup-config-scanned', { detail }));
            return true;
          }
        }
      } catch {}
    }

    // 2. URLまたはクエリ文字列形式の検出: ?dbid=...&api=... 等
    try {
      const urlCandidate = str.includes('://') ? str : `http://localhost/${str.startsWith('?') ? str : '?' + str}`;
      const url = new URL(urlCandidate);
      const params = url.searchParams;

      const apiKey = params.get('api') || params.get('apiKey') || params.get('api_key') || params.get('key') || params.get('token') || params.get('secret');
      const dbId = params.get('dbid') || params.get('db') || params.get('db_id') || params.get('database_id') || params.get('databaseId');
      const itemDbId = params.get('itemDbId') || params.get('item_db_id');
      const locationDbId = params.get('locationDbId') || params.get('locid') || params.get('location_db_id');
      const proxyMode = params.get('proxy') || params.get('proxyMode');
      const customProxyUrl = params.get('customProxyUrl') || params.get('proxyUrl');
      const jevApiKey = params.get('jev') || params.get('jevApiKey') || params.get('jev_api_key');
      const jevMaxAttributes = params.get('jevmax') || params.get('jev_max') || params.get('jevMax');

      if (apiKey || dbId || itemDbId || locationDbId || jevApiKey || jevMaxAttributes) {
        const detail = {};
        if (apiKey) detail.apiKey = apiKey.trim();
        if (dbId) detail.dbId = dbId.trim();
        if (itemDbId) detail.itemDbId = itemDbId.trim();
        if (locationDbId) detail.locationDbId = locationDbId.trim();
        if (proxyMode) detail.proxyMode = proxyMode.trim();
        if (customProxyUrl) detail.customProxyUrl = customProxyUrl.trim();
        if (jevApiKey) detail.jevApiKey = jevApiKey.trim();
        if (jevMaxAttributes) detail.jevMaxAttributes = parseInt(jevMaxAttributes, 10);

        this.dispatchEvent(new CustomEvent('setup-config-scanned', { detail }));
        return true;
      }
    } catch {}

    // 3. Notion APIキー単体の検出: ntn_... または secret_...
    if (/^(ntn_[a-zA-Z0-9_-]+|secret_[a-zA-Z0-9_-]+)$/.test(str)) {
      this.dispatchEvent(new CustomEvent('setup-config-scanned', {
        detail: { apiKey: str }
      }));
      return true;
    }

    // 4. Jev APIキー単体の検出: jev_...
    if (/^jev_[a-zA-Z0-9_-]+$/.test(str)) {
      this.dispatchEvent(new CustomEvent('setup-config-scanned', {
        detail: { jevApiKey: str }
      }));
      return true;
    }

    // 5. Notion データベースURLまたは32桁UUID単体の検出
    if (str.includes('notion.so') || str.includes('notion.com') || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str) || /^[0-9a-fA-F]{32}$/.test(str)) {
      if (!/^\d+$/.test(str)) {
        const extracted = NotionClient.extractDatabaseId(str);
        if (extracted) {
          this.dispatchEvent(new CustomEvent('setup-config-scanned', {
            detail: { dbId: extracted }
          }));
          return true;
        }
      }
    }

    // 6. 複数行テキストからの検出 (APIキーやDB URLが混在する形式)
    if (str.includes('\n')) {
      const lines = str.split(/\r?\n/);
      let foundApi = null;
      let foundDb = null;
      let foundJev = null;
      for (const line of lines) {
        const l = line.trim();
        const apiMatch = l.match(/(?:api[_-]?key|api|token|secret)?[:=\s]*(ntn_[a-zA-Z0-9_-]+|secret_[a-zA-Z0-9_-]+)/i);
        if (apiMatch) foundApi = apiMatch[1];

        const dbMatch = l.match(/(?:db[_-]?id|db|database)?[:=\s]*(https?:\/\/[^\s]+|[0-9a-fA-F-]{32,36})/i);
        if (dbMatch && !/^\d+$/.test(dbMatch[1])) {
          const extracted = NotionClient.extractDatabaseId(dbMatch[1]);
          if (extracted) foundDb = extracted;
        }

        const jevMatch = l.match(/(?:jev[_-]?api[_-]?key|jev[_-]?key|jev)?[:=\s]*(jev_[a-zA-Z0-9_-]+)/i);
        if (jevMatch) foundJev = jevMatch[1];
      }
      if (foundApi || foundDb || foundJev) {
        const detail = {};
        if (foundApi) detail.apiKey = foundApi;
        if (foundDb) detail.dbId = foundDb;
        if (foundJev) detail.jevApiKey = foundJev;
        this.dispatchEvent(new CustomEvent('setup-config-scanned', { detail }));
        return true;
      }
    }

    return false;
  }

  /**
   * Web NFC APIの初期化
   */
  async startNfc() {
    if (!('NDEFReader' in window)) {
      return false;
    }

    try {
      this.nfcReader = new window.NDEFReader();
      await this.nfcReader.scan();
      this.isNfcActive = true;

      this.nfcReader.addEventListener('reading', ({ message }) => {
        for (const record of message.records) {
          if (record.recordType === 'url' || record.recordType === 'text') {
            const textDecoder = new TextDecoder(record.encoding || 'utf-8');
            const data = textDecoder.decode(record.data);
            this._onScanSuccess(data);
            break;
          }
        }
      });

      this.nfcReader.addEventListener('readingerror', () => {
        feedback.playError();
      });

      return true;
    } catch (err) {
      console.warn('[Scanner] Web NFC not permitted or available:', err);
      this.isNfcActive = false;
      return false;
    }
  }

  /**
   * Web NFCが利用可能かどうかを判定
   */
  isNfcSupported() {
    return ('NDEFReader' in window);
  }

  /**
   * Web NFC APIによりNFCタグへURLを書き込む
   * @param {string} url 書き込むURL
   * @param {AbortSignal} [signal] 書き込み待機キャンセル用シグナル
   */
  async writeNfc(url, signal = null) {
    if (!this.isNfcSupported()) {
      throw new Error('お使いの環境（ブラウザ/OS）はWeb NFC書き込みに対応していません。');
    }

    try {
      const ndef = new window.NDEFReader();
      const options = {};
      if (signal) {
        options.signal = signal;
      }

      await ndef.write({
        records: [
          {
            recordType: 'url',
            data: url
          }
        ]
      }, options);

      return true;
    } catch (err) {
      console.error('[Scanner] NFC Write Error:', err);
      throw err;
    }
  }
}

export const scanner = new ScannerService();
