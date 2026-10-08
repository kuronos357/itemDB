"""
PaSoRi RC-S300: NFCタグ 1枚検出スクリプト
タグが乗せられるまで待機し、検出したら情報を表示して自動終了します。
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
    def beep_ok(): winsound.Beep(2000, 150)
    def beep_err(): winsound.Beep(800, 300)
except Exception:
    def beep_ok(): pass
    def beep_err(): pass


def main():
    r_list = readers()
    if not r_list:
        print("[!] リーダーが見つかりません。")
        sys.exit(1)

    reader = r_list[0]
    print(f"[OK] リーダー接続完了: {reader}")
    print("[*] タグをリーダーの上に乗せてください... (最大60秒待機)")

    timeout = 60
    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            connection = reader.createConnection()
            connection.connect()

            # 1. UID 取得 (FF CA 00 00 00)
            GET_UID = [0xFF, 0xCA, 0x00, 0x00, 0x00]
            data, sw1, sw2 = connection.transmit(GET_UID)

            if sw1 == 0x90 and sw2 == 0x00:
                beep_ok()
                print(f"\n==========================================")
                print(f"[★] タグを検出しました！")
                print(f"    UID: {toHexString(data)} ({len(data)} bytes)")

                # 2. Page 3 (Capability Container)
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

                # 3. Page 4〜7 (先頭16バイト: 既存NDEF)
                READ_PAGE4 = [0xFF, 0xB0, 0x00, 0x04, 0x10]
                p4_data, p_sw1, p_sw2 = connection.transmit(READ_PAGE4)
                if p_sw1 == 0x90 and p_sw2 == 0x00:
                    print(f"    既存データ (Page 4-7): {toHexString(p4_data)}")
                    ascii_preview = "".join(chr(b) if 32 <= b <= 126 else "." for b in p4_data)
                    print(f"    ASCIIプレビュー: {ascii_preview}")
                else:
                    READ_PAGE4_4B = [0xFF, 0xB0, 0x00, 0x04, 0x04]
                    p4_4b, p_sw1_4b, p_sw2_4b = connection.transmit(READ_PAGE4_4B)
                    if p_sw1_4b == 0x90:
                        print(f"    既存データ (Page 4): {toHexString(p4_4b)}")
                    else:
                        print(f"    Page 4 読み取りレスポンス: SW={p_sw1:02X}{p_sw2:02X}")

                print(f"==========================================")
                sys.exit(0)

            time.sleep(0.3)

        except (NoCardException, CardConnectionException):
            time.sleep(0.2)
        except Exception as e:
            time.sleep(0.3)

    print("\n[!] 60秒以内にタグが検出されませんでした。")
    sys.exit(1)


if __name__ == "__main__":
    main()
