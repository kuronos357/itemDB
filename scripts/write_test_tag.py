"""
PaSoRi RC-S300: NFCタグ書き込みテストスクリプト
リーダーの上にタグを置くと、指定URL (NDEF URI) を書き込み、直後にベリファイ（読み取り検証）を行います。
"""
import sys
import time

if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

from smartcard.System import readers
from smartcard.util import toHexString
from smartcard.Exceptions import NoCardException, CardConnectionException

try:
    import winsound
    def beep_ok():
        winsound.Beep(2000, 120)
        time.sleep(0.05)
        winsound.Beep(2500, 120)
    def beep_err():
        winsound.Beep(800, 300)
except Exception:
    def beep_ok(): pass
    def beep_err(): pass


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

    # NDEF Record (MB=1, ME=1, SR=1, TNF=1, Type='U')
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload

    # NDEF TLV (T=0x03)
    if len(record) < 255:
        tlv = bytes([0x03, len(record)]) + record + bytes([0xFE])
    else:
        tlv = bytes([0x03, 0xFF, (len(record) >> 8) & 0xFF, len(record) & 0xFF]) + record + bytes([0xFE])

    # 4バイト境界にパディング
    pad_len = (4 - (len(tlv) % 4)) % 4
    tlv += bytes([0x00] * pad_len)
    return tlv


def write_tag(url: str, timeout: int = 45):
    r_list = readers()
    if not r_list:
        print("[!] リーダーが見つかりません。")
        sys.exit(1)

    reader = r_list[0]
    print(f"[OK] リーダー: {reader}")
    print(f"[*] 書き込むURL: {url}")
    print(f"[*] タグをリーダーの上に乗せてください... (最大{timeout}秒待機)")

    tlv_data = make_ndef_uri_tlv(url)
    num_pages = len(tlv_data) // 4
    start_page = 4

    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            connection = reader.createConnection()
            connection.connect()

            # UID取得
            GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]
            uid_data, sw1, sw2 = connection.transmit(GET_UID)
            if sw1 != 0x90 or sw2 != 0x00:
                time.sleep(0.2)
                continue

            uid_str = toHexString(uid_data)
            print(f"\n[★] タグ検出！ UID: {uid_str}")

            # Capability Container (Page 3) 確認
            # もしCCが 00 00 00 00 などの未フォーマット状態なら初期化 (NTAG213/215互換)
            read_cc_cmd = [0xFF, 0xB0, 0x00, 0x03, 0x10]
            cc_res, c_sw1, c_sw2 = connection.transmit(read_cc_cmd)
            if c_sw1 == 0x90 and len(cc_res) >= 4:
                cc_bytes = cc_res[:4]
                if cc_bytes[0] == 0x00:
                    print("    CC未初期化を検出。NTAG標準CC (E1 10 12 00) を書き込みます...")
                    write_cc_cmd = [0xFF, 0xD6, 0x00, 0x03, 0x04, 0xE1, 0x10, 0x12, 0x00]
                    connection.transmit(write_cc_cmd)

            # ページ 4 から順に 4バイトずつ書き込み
            print(f"    書き込み中... ({num_pages} ページ / 計 {len(tlv_data)} バイト)")
            write_success = True
            for i in range(num_pages):
                page_idx = start_page + i
                page_data = list(tlv_data[i * 4 : (i + 1) * 4])
                write_cmd = [0xFF, 0xD6, 0x00, page_idx, 0x04] + page_data
                res, w_sw1, w_sw2 = connection.transmit(write_cmd)
                if w_sw1 != 0x90 or w_sw2 != 0x00:
                    print(f"    [!] Page {page_idx} 書き込み失敗: SW={w_sw1:02X}{w_sw2:02X}")
                    write_success = False
                    break

            if not write_success:
                beep_err()
                print("    書き込みに失敗しました。")
                sys.exit(1)

            # ベリファイ (読み取り検証)
            print("    検証中 (ベリファイ)...")
            verify_success = True
            for i in range(num_pages):
                page_idx = start_page + i
                read_cmd = [0xFF, 0xB0, 0x00, page_idx, 0x10] # 16バイト読む
                read_res, r_sw1, r_sw2 = connection.transmit(read_cmd)
                if r_sw1 != 0x90 or len(read_res) < 4:
                    # 4バイト読み込みで再試行
                    read_cmd_4 = [0xFF, 0xB0, 0x00, page_idx, 0x04]
                    read_res, r_sw1, r_sw2 = connection.transmit(read_cmd_4)
                    if r_sw1 != 0x90:
                        verify_success = False
                        break
                read_page_data = bytes(read_res[:4])
                expected_page_data = tlv_data[i * 4 : (i + 1) * 4]
                if read_page_data != expected_page_data:
                    print(f"    [!] Page {page_idx} 不一致: 期待={expected_page_data.hex()} 実際={read_page_data.hex()}")
                    verify_success = False
                    break

            if verify_success:
                beep_ok()
                print(f"[✓✓] 書き込み＆検証成功！")
                print(f"     書き込み完了URL: {url}")
                print(f"     スマホをかざして正常にブラウザが開くか確認できます！")
                sys.exit(0)
            else:
                beep_err()
                print("    [!] ベリファイに失敗しました。")
                sys.exit(1)

        except (NoCardException, CardConnectionException):
            time.sleep(0.2)
        except Exception as e:
            # print(f"エラー: {e}")
            time.sleep(0.3)

    print("\n[!] タイムアウト: タグが検出されませんでした。")
    sys.exit(1)


if __name__ == "__main__":
    target_url = "https://itemdb.pages.dev/?id=1001"
    if len(sys.argv) > 1:
        target_url = sys.argv[1]
    write_tag(target_url)
