"""Локальный хостинг Loop через Gunicorn (HTTP или HTTPS)."""

import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

from app import app

BASE_DIR = Path(__file__).resolve().parent
CERT_DIR = BASE_DIR / "certs"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


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


def _ensure_certificate(lan_ip: str) -> tuple[Path, Path] | None:
    """Создаёт самоподписанный сертификат для GPS на телефоне."""
    if CERT_FILE.is_file() and KEY_FILE.is_file():
        return CERT_FILE, KEY_FILE

    openssl = shutil.which("openssl")
    if not openssl:
        print("OpenSSL не найден — HTTPS будет недоступен, GPS на телефоне не заработает.")
        return None

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    san = f"IP:{lan_ip},IP:127.0.0.1,DNS:localhost"
    command = [
        openssl,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "365",
        "-keyout",
        str(KEY_FILE),
        "-out",
        str(CERT_FILE),
        "-subj",
        f"/CN={lan_ip}",
        "-addext",
        f"subjectAltName={san}",
    ]
    try:
        subprocess.run(
            command,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Не удалось создать сертификат: {exc}")
        return None

    print(f"Создан локальный HTTPS-сертификат для {lan_ip} (папка certs/).")
    return CERT_FILE, KEY_FILE


def main() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5050"))
    use_https = os.getenv("HTTPS", "1").lower() not in {"0", "false", "no", "off"}
    lan_ip = _lan_ip()

    certificate = _ensure_certificate(lan_ip) if use_https else None
    scheme = "https" if certificate else "http"

    print("=" * 64)
    print(" Loop — локальный хостинг")
    print(f" На этом устройстве: {scheme}://127.0.0.1:{port}/")
    if host not in {"127.0.0.1", "localhost"} and lan_ip != "127.0.0.1":
        print(f" Телефон в Wi-Fi:    {scheme}://{lan_ip}:{port}/")
    if certificate:
        print(" Сертификат самоподписанный: браузер спросит подтверждение.")
        print(" Для GPS на телефоне это нормально — нажмите «Дополнительно» → «Перейти».")
    else:
        print(" HTTPS выключен: GPS на телефоне работать не будет.")
        print(" Включить: HTTPS=1 ./start.sh")
    print(" Остановить: Ctrl+C")
    print("=" * 64, flush=True)

    gunicorn = Path(sys.executable).with_name("gunicorn")
    if not gunicorn.is_file():
        print("Gunicorn не установлен. Выполните: pip install -r requirements.txt")
        raise SystemExit(1)

    command = [
        str(gunicorn),
        "--bind",
        f"{host}:{port}",
        "--workers",
        "1",
        "--worker-class",
        "gthread",
        "--threads",
        "8",
        "--timeout",
        "120",
        "--access-logfile",
        "-",
        "--error-logfile",
        "-",
    ]
    if certificate:
        command.extend(
            [
                "--certfile",
                str(certificate[0]),
                "--keyfile",
                str(certificate[1]),
            ]
        )
    command.append("app:app")

    try:
        os.execv(str(gunicorn), command)
    except OSError as exc:
        print(f"Не удалось запустить Gunicorn: {exc}")
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
