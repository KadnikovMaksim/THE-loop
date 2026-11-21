"""Локальный хостинг Loop на этом устройстве через Waitress."""

import os
import socket
import subprocess
import sys

from waitress import serve

from app import app


def _lan_ip() -> str:
    """Определяет IP компьютера в локальной сети для ссылки с телефона."""
    if sys.platform == "darwin":
        for interface in ("en0", "en1", "en2"):
            try:
                ip = subprocess.check_output(
                    ["ipconfig", "getifaddr", interface],
                    text=True,
                    stderr=subprocess.DEVNULL,
                    timeout=1,
                ).strip()
            except (OSError, subprocess.SubprocessError):
                continue
            if ip and not ip.startswith("127."):
                return ip

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.3)
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5050"))
    lan_ip = _lan_ip()

    print("=" * 58)
    print(" Loop — локальный хостинг")
    print(f" На этом устройстве: http://127.0.0.1:{port}/")
    if host not in {"127.0.0.1", "localhost"} and lan_ip != "127.0.0.1":
        print(f" Телефон в Wi-Fi:    http://{lan_ip}:{port}/")
    print(" Остановить: Ctrl+C")
    print("=" * 58, flush=True)

    try:
        serve(app, host=host, port=port, threads=8)
    except OSError as exc:
        print(
            f"\nНе удалось запустить хостинг на {host}:{port}: {exc}\n"
            "Попробуйте другой порт: PORT=5051 ./start.sh\n"
        )
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
