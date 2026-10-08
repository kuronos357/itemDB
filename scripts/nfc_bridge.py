"""
itemDB - Local NFC Bridge Server (PaSoRi RC-S300)
Windows PWA から PaSoRi RC-S300 への NFC タグ書き込みを中継するローカル HTTP サーバー
"""
import sys
import json
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

try:
    from smartcard.System import readers
    from smartcard.util import toHexString
    from smartcard.Exceptions import NoCardException, CardConnectionException
except ImportError:
    print("[!] エラー: pyscard がインストールされていません。")
    print("    py -3.13 -m pip install pyscard を実行してください。")
    sys.exit(1)

try:
    import winsound
    def beep_ok():
        winsound.Beep(2000, 100)
        time.sleep(0.04)
        winsound.Beep(2500, 100)
    def beep_err():
        winsound.Beep(800, 250)
except Exception:
    def beep_ok(): pass
    def beep_err(): pass

PORT = 8765
HOST = "127.0.0.1"


def make_ndef_uri_tlv(url: str) -> bytes:
    """URLからNDEF URIレコードを含むTLVバイト列（4バイト境界パディング済み）を生成"""
    prefixes = [
        ("http://www.", 0x01),
        ("https://www.", 0x02),
        ("http://", 0x03),
        ("https://", 0x04),
    ]
    prefix_code = 0x00
    prefix_len = 0
    for p, code in prefixes:
        if url.startswith(p):
            prefix_code = code
            prefix_len = len(p)
            break

    if prefix_code != 0:
        uri_body = url[prefix_len:].encode('utf-8')
        payload = bytes([prefix_code]) + uri_body
    else:
        payload = bytes([0x00]) + url.encode('utf-8')

    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload

    if len(record) < 255:
        tlv = bytes([0x03, len(record)]) + record + bytes([0xFE])
    else:
        tlv = bytes([0x03, 0xFF, (len(record) >> 8) & 0xFF, len(record) & 0xFF]) + record + bytes([0xFE])

    pad_len = (4 - (len(tlv) % 4)) % 4
    tlv += bytes([0x00] * pad_len)
    return tlv


def write_nfc_direct(url: str, timeout: int = 15):
    """リーダー上のタグにURLを書き込み＆ベリファイ"""
    r_list = readers()
    if not r_list:
        return {"success": False, "error": "PaSoRiリーダーが検出されません。USB接続を確認してください。"}

    reader = r_list[0]
    tlv_data = make_ndef_uri_tlv(url)
    num_pages = len(tlv_data) // 4
    start_page = 4

    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            connection = reader.createConnection()
            connection.connect()

            # UID取得
            uid_data, sw1, sw2 = connection.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])
            if sw1 != 0x90 or sw2 != 0x00:
                time.sleep(0.2)
                continue

            uid_str = toHexString(uid_data)

            # Capability Container (Page 3) 確認 & 初期化
            cc_res, c_sw1, c_sw2 = connection.transmit([0xFF, 0xB0, 0x00, 0x03, 0x10])
            if c_sw1 == 0x90 and len(cc_res) >= 4 and cc_res[0] == 0x00:
                connection.transmit([0xFF, 0xD6, 0x00, 0x03, 0x04, 0xE1, 0x10, 0x12, 0x00])

            # ページ書き込み
            for i in range(num_pages):
                page_idx = start_page + i
                page_data = list(tlv_data[i * 4 : (i + 1) * 4])
                res, w_sw1, w_sw2 = connection.transmit([0xFF, 0xD6, 0x00, page_idx, 0x04] + page_data)
                if w_sw1 != 0x90 or w_sw2 != 0x00:
                    beep_err()
                    return {"success": False, "error": f"Page {page_idx} の書き込みに失敗しました (SW={w_sw1:02X}{w_sw2:02X})"}

            # ベリファイ (読み取り検証)
            for i in range(num_pages):
                page_idx = start_page + i
                read_res, r_sw1, r_sw2 = connection.transmit([0xFF, 0xB0, 0x00, page_idx, 0x10])
                if r_sw1 != 0x90 or len(read_res) < 4:
                    read_res, r_sw1, r_sw2 = connection.transmit([0xFF, 0xB0, 0x00, page_idx, 0x04])
                read_chunk = bytes(read_res[:4])
                expected = tlv_data[i * 4 : (i + 1) * 4]
                if read_chunk != expected:
                    beep_err()
                    return {"success": False, "error": f"ベリファイ不一致 (Page {page_idx})"}

            beep_ok()
            return {
                "success": True,
                "uid": uid_str,
                "url": url,
                "pages": num_pages,
                "bytes": len(tlv_data)
            }

        except (NoCardException, CardConnectionException):
            time.sleep(0.2)
        except Exception as e:
            time.sleep(0.2)

    beep_err()
    return {"success": False, "error": f"タグが検出されませんでした（{timeout}秒タイムアウト）"}


class NfcBridgeHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path == "/status" or self.path == "/":
            r_list = readers()
            connected = len(r_list) > 0
            reader_name = str(r_list[0]) if connected else None

            # 現在タグが載っているか簡易チェック
            has_tag = False
            uid = None
            if connected:
                try:
                    c = r_list[0].createConnection()
                    c.connect()
                    d, s1, s2 = c.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])
                    if s1 == 0x90 and s2 == 0x00:
                        has_tag = True
                        uid = toHexString(d)
                except Exception:
                    pass

            response_data = {
                "bridge": "itemdb-pasori-bridge",
                "version": "1.0",
                "reader_connected": connected,
                "reader_name": reader_name,
                "has_tag": has_tag,
                "current_uid": uid
            }

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/write":
            content_len = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_len)
            try:
                data = json.loads(body.decode('utf-8'))
                url = data.get("url", "").strip()
                if not url:
                    raise ValueError("URLが指定されていません。")

                print(f"[*] 書き込みリクエスト受信: {url}")
                result = write_nfc_direct(url, timeout=15)
                print(f"    結果: {'成功' if result.get('success') else '失敗'} ({result.get('error', '')})")

                self.send_response(200 if result.get('success') else 400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))

            except Exception as e:
                self.send_response(400)
                self._send_cors_headers()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # アクセスログの簡易出力
        pass


def run_server():
    server = HTTPServer((HOST, PORT), NfcBridgeHandler)
    print(f"==================================================")
    print(f"  itemDB PaSoRi NFC Bridge 起動完了")
    print(f"  URL: http://{HOST}:{PORT}")
    print(f"  PWAの画面から直接NFCタグ書き込みが可能になります")
    print(f"==================================================")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました。")


if __name__ == "__main__":
    run_server()
