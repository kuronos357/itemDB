@echo off
chcp 65001 > nul
echo ==================================================
echo   itemDB PaSoRi NFC Bridge を起動しています...
echo ==================================================
py -3.13 scripts\nfc_bridge.py
pause
