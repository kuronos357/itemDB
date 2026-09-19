/**
 * itemDB - Scanner & NFC Integration
 * 
 * カメラによるQRコード読み取り (html5-qrcode)、
 * Web NFC API (NDEFReader) によるタグ読み取り、
 * URL解析とID抽出を担当します。
 */

import { state } from './state.js';
import { feedback } from './audio.js';

class ScannerService extends EventTarget {
  constructor() {
    super();
    this.html5QrCode = null;
    this.isScanning = false;
    this.lastScannedText = null;
    this.lastScannedTime = 0;
    this.nfcReader = null;
    this.isNfcActive = false;
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
   * カメラQRスキャナの初期化・起動
   */
  async startCamera(elementId = 'qr-reader') {
    if (this.isScanning) return;

    if (!window.Html5Qrcode) {
      console.warn('[Scanner] Html5Qrcode library not loaded.');
      return;
    }

    try {
      this.html5QrCode = new window.Html5Qrcode(elementId);
      const config = {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const edge = Math.floor(minEdge * 0.75);
          return { width: edge, height: edge };
        },
        aspectRatio: 1.0,
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true
        }
      };

      await this.html5QrCode.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => this._onScanSuccess(decodedText),
        () => {} // スキャン途中のフレームミスは無視
      );

      this.isScanning = true;
      this.dispatchEvent(new CustomEvent('scanner-started'));
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

    // 初期設定URL (?dbid=...&api=...) かどうか判定
    if (this._checkSetupUrl(decodedText)) {
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
   * 初期設定QRコード (?dbid=...&api=...) の検知
   */
  _checkSetupUrl(text) {
    try {
      const url = new URL(text, window.location.origin);
      const dbid = url.searchParams.get('dbid');
      const api = url.searchParams.get('api');
      if (dbid && api) {
        this.dispatchEvent(new CustomEvent('setup-url-scanned', {
          detail: { dbid, api }
        }));
        return true;
      }
    } catch {
      // not a URL
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
}

export const scanner = new ScannerService();
