"""
PaSoRi RC-S300 接続確認 & NFCタグ読み取りテストスクリプト
"""
import sys
import time

# UTF-8 出力設定
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
    print("エラー: pyscard がインストールされていません。")
    print("py -3.13 -m pip install pyscard を実行してください。")
    sys.exit(1)


def check_reader():
    try:
        r_list = readers()
    except Exception:
        print("[!] スマートカードサービスが待機状態です。")
        print("    -> PaSoRi (RC-S300) のUSBケーブルをPCに接続してください。")
        print("       (リーダーが接続されるとWindowsが自動認識してサービスが起動します)")
        return None

    if not r_list:
        print("[!] リーダーが見つかりません。USB接続を確認してください。")
        return None
    print(f"[OK] リーダー検出: {r_list[0]}")
    return r_list[0]


def poll_tag(reader):
    print("\n[i] リーダーの上にNFCタグを置いてください... (Ctrl+C で終了)")
    last_uid = None

    while True:
        try:
            connection = reader.createConnection()
            connection.connect()

            # UID取得コマンド (PC/SC標準: FF CA 00 00 00)
            GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]
            data, sw1, sw2 = connection.transmit(GET_UID)

            if sw1 == 0x90 and sw2 == 0x00:
                uid_str = toHexString(data)
                if uid_str != last_uid:
                    print(f"\n[★] タグを検出しました！")
                    print(f"    UID: {uid_str} ({len(data)} bytes)")

                    # CC (Capability Container, Page 3) 読み取りテスト
                    READ_PAGE3 = [0xFF, 0xB0, 0x00, 0x03, 0x04]
                    cc_data, cc_sw1, cc_sw2 = connection.transmit(READ_PAGE3)
                    if cc_sw1 == 0x90:
                        print(f"    CC (Page 3): {toHexString(cc_data)}")
                        if len(cc_data) >= 3:
                            size_byte = cc_data[2]
                            mem_size = size_byte * 8
                            print(f"    推定メモリサイズ: 約{mem_size}バイト")

                    last_uid = uid_str
                    print("[i] タグを離してください...")
            time.sleep(0.5)

        except (NoCardException, CardConnectionException):
            last_uid = None
            time.sleep(0.3)
        except KeyboardInterrupt:
            print("\n終了しました。")
            break
        except Exception as e:
            time.sleep(0.5)


if __name__ == "__main__":
    r = check_reader()
    if r:
        poll_tag(r)
