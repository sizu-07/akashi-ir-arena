"""USB serial configuration. Requires pyserial; never prints credentials."""
import argparse, json, time
import serial
p = argparse.ArgumentParser(description='XIAO ESP32-S3 Plusへv0.6のWi-Fi設定をUSB転送')
p.add_argument('--port', required=True, help='例: COM5')
p.add_argument('--file', required=True, help='config/provision/gun-001.json')
args = p.parse_args()
with open(args.file, encoding='utf-8-sig') as f:
    config = json.load(f)
if config.get('hardwareProfile') != 'xiao-s3-plus-3rx-motor':
    raise SystemExit('v0.6のhardwareProfileが必要です。PC画面でWi-Fi設定を再作成してください。')
with serial.Serial(args.port, 115200, timeout=1) as device:
    time.sleep(2)
    device.write((json.dumps(config) + '\n').encode())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = device.readline().decode(errors='replace')
        if 'SAVED:' in response:
            print('設定保存を確認しました。ESP32が再起動します。')
            break
    else:
        raise SystemExit('保存応答なし。USBの実行用COM番号とシリアルモニターの占有を確認してください。')
