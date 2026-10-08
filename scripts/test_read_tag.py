"""
PaSoRi RC-S300: NFCタグ読み取り・検出スクリプト
リーダーの上にタグを置くと、UIDとメモリ先頭データを読み取って表示します。
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
        winsound.Beep(2000, 100)
    def beep_err():
        winsound.Beep(800, 250)
except Exception:
    def beep_ok(): pass
    def beep_err(): pass


def main():
    r_list = readers()
    if not r_list:
        print("[!] リーダーが見つかりません。")
        return

    reader = r_list[0]
    print(f"[OK] リーダー接続完了: {reader}")
    print("[*] タグをリーダーの上に置いてください... (Ctrl+C で終了)")

    last_uid = None

    while True:
        try:
            connection = reader.createConnection()
            connection.connect()

            # 1. UID 取得 (FF CA 00 00 00)
            GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]
            data, sw1, sw2 = connection.transmit(GET_UID)

            if sw1 == 0x90 and sw2 == 0x00:
                uid_str = toHexString(data)
                if uid_str != last_uid:
                    beep_ok()
                    print(f"\n==========================================")
                    print(f"[★] タグを検出しました！")
                    print(f"    UID: {uid_str}")

                    # 2. Page 3 (Capability Container) 読み取り
                    # PC/SC標準 Read Binary: FF B0 00 [page] [len]
                    READ_CC = [0xFF, 0xB0, 0x00, 0x03, 0x04]
                    cc_data, c_sw1, c_sw2 = connection.transmit(READ_CC)
                    if c_sw1 == 0x90 and c_sw2 == 0x00:
                        print(f"    CC (Page 3): {toHexString(cc_data)}")
                        if len(cc_data) >= 3 and cc_data[0] == 0xE1:
                            size_mult = cc_data[2]
                            total_user_mem = size_mult * 8
                            print(f"    ユーザーメモリ: {total_user_mem} bytes")
                            if total_user_mem <= 144:
                                print(f"    タグ種別: NTAG213 (または同等品)")
                            elif total_user_mem <= 504:
                                print(f"    タグ種別: NTAG215")
                            else:
                                print(f"    タグ種別: NTAG216")
                    else:
                        print(f"    CC 読み取りレスポンス: SW={c_sw1:02X}{c_sw2:02X}")

                    # 3. Page 4〜7 (先頭16バイト: 既存NDEF) 読み取り
                    READ_PAGE4 = [0xFF, 0xB0, 0x00, 0x04, 0x10]
                    p4_data, p_sw1, p_sw2 = connection.transmit(READ_PAGE4)
                    if p_sw1 == 0x90 and p_sw2 == 0x00:
                        print(f"    既存データ (Page 4-7): {toHexString(p4_data)}")
                        # ASCII文字として読める部分があれば表示
                        ascii_preview = "".join(chr(b) if 32 <= b <= 126 else "." for b in p4_data)
                        print(f"    ASCIIプレビュー: {ascii_preview}")
                    else:
                        # 4バイト読み込みで再試行
                        READ_PAGE4_4B = [0xFF, 0xB0, 0x00, 0x04, 0x04]
                        p4_4b, p_sw1_4b, p_sw2_4b = connection.transmit(READ_PAGE4_4B)
                        if p_sw1_4b == 0x90:
                            print(f"    既存データ (Page 4): {toHexString(p4_4b)}")
                        else:
                            print(f"    Page 4 読み取りレスポンス: SW={p_sw1:02X}{p_sw2:02X}")

                    print(f"==========================================")
                    print("[i] タグを離してください（次のタグを置くと再検出します）")
                    last_uid = uid_str

            time.sleep(0.3)

        except (NoCardException, CardConnectionException):
            last_uid = None
            time.sleep(0.2)
        except KeyboardInterrupt:
            print("\n終了しました。")
            break
        except Exception as e:
            # print(f"エラー: {e}")
            time.sleep(0.5)


if __name__ == "__main__":
    main()
