"""
THE-loop — пешие прогулки через интересные места.

Приложение строит пеший маршрут A → B с промежуточными остановками
из OpenStreetMap. Если Overpass недоступен, используется локальная
выгрузка saratov.geojson (без смешивания источников).

Настройки через переменные окружения (можно положить в .env рядом с app.py):
    OVERPASS_TIMEOUT     — таймаут запроса к Overpass, сек (по умолчанию 8)
    OVERPASS_COOLDOWN    — пауза перед повторной проверкой упавшего зеркала, сек (90)
    ROUTING_TIMEOUT      — таймаут запроса к маршрутизатору, сек (12)
    MAX_BBOX_DIAGONAL_KM — максимальная диагональ области поиска, км (150)
    HOST                 — адрес, по умолчанию 127.0.0.1
    PORT                 — порт, по умолчанию 5000
    FLASK_DEBUG          — 1/true для режима отладки (по умолчанию выключен)
"""

from __future__ import annotations

import html as html_lib
import json
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

APP_NAME = "THE-loop"
BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    """Минимальный загрузчик .env без дополнительных зависимостей."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv(BASE_DIR / ".env")
# .env уже прочитан нашим загрузчиком; не просим Flask ставить python-dotenv.
os.environ.setdefault("FLASK_SKIP_DOTENV", "1")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024  # 1 MB — запросам больше не нужно
app.json.ensure_ascii = False

# --- СОСТОЯНИЕ НА СЕРВЕРЕ (В ПЕРЕМЕННЫХ) ---
# Оставлено для обратной совместимости с /api/points. Новый фронтенд
# передаёт точки в каждом запросе, поэтому общий state не влияет на него.
state_lock = threading.RLock()
point_a = None         # {"lat": float, "lon": float} | None
point_b = None         # {"lat": float, "lon": float} | None
current_bbox = None    # {"south": float, "west": float, "north": float, "east": float} | None
found_places = []      # список словарей найденных мест
found_places_bbox_key = None
found_places_source = None
found_places_meta = {}
last_route_data = None  # последний построенный маршрут

# Файл выгрузки GeoJSON из overpass-turbo по Саратову (положи рядом с app.py)
SARATOV_GEOJSON_FILE = BASE_DIR / "saratov.geojson"
_saratov_places_cache: list[dict] | None = None
_saratov_coverage: dict | None = None
_saratov_mtime: float | None = None
_geojson_lock = threading.Lock()

# --- НАСТРОЙКИ ВНЕШНИХ СЕРВИСОВ ---
# Подложка карты — всегда стандартные тайлы OpenStreetMap.

# api.overpass-turbo.eu — это прокси, который часто лежит. Используем
# официальное API и публичные зеркала, а turbo оставляем последним шансом.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://api.overpass-turbo.eu/interpreter",
]
OVERPASS_TIMEOUT = float(os.getenv("OVERPASS_TIMEOUT", "8"))
OVERPASS_READ_TIMEOUT = max(3.0, OVERPASS_TIMEOUT + 3.0)
OVERPASS_COOLDOWN = float(os.getenv("OVERPASS_COOLDOWN", "90"))
OVERPASS_QUERY_TIMEOUT = max(5, min(25, int(OVERPASS_TIMEOUT)))
OVERPASS_CONTACT = os.getenv("OVERPASS_CONTACT", "local educational project")
OVERPASS_HEADERS = {
    "Accept": "application/json, */*;q=0.5",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent": f"{APP_NAME}/2.0 ({OVERPASS_CONTACT})",
}

# Состояние «предохранителей» для зеркал: не долбим упавший сервис на каждом запросе.
_overpass_guard_lock = threading.Lock()
_overpass_failed_until: dict[str, float] = {}

# Небольшой кэш результатов: категории на клиенте фильтруются локально,
# но повторный поиск с теми же точками не должен заново ждать Overpass.
_places_cache_lock = threading.Lock()
_places_cache: dict[tuple, dict] = {}
PLACES_CACHE_MAX = 32
CACHE_TTL_LIVE = 120.0
CACHE_TTL_LOCAL = 30.0

FOOT_ROUTING_URLS = [
    "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
    "https://router.project-osrm.org/route/v1/foot",
]
ROUTING_TIMEOUT = float(os.getenv("ROUTING_TIMEOUT", "12"))
ROUTING_TOTAL_BUDGET = max(20.0, ROUTING_TIMEOUT * 2.0)
# OSRM-серверы ограничивают число точек в одном запросе; длинный маршрут режем на куски.
ROUTE_MAX_WAYPOINTS = 25

# --- ФОТОГРАФИИ ДОСТОПРИМЕЧАТЕЛЬНОСТЕЙ ---
# Wikimedia Commons / Wikipedia не требуют ключа и отдают свободные лицензии.
WIKIMEDIA_TIMEOUT = float(os.getenv("WIKIMEDIA_TIMEOUT", "6"))
WIKIMEDIA_USER_AGENT = f"{APP_NAME}/2.0 (local walking-route demo)"
IMAGE_CACHE_TTL = 24 * 60 * 60
IMAGE_NEGATIVE_TTL = 60 * 60
IMAGE_CACHE_MAX = 400
_image_cache_lock = threading.Lock()
_image_cache: dict[tuple, dict] = {}
_IMAGE_HOSTS = {"upload.wikimedia.org", "thumb.wikimedia.org"}
_PAGE_HOSTS = {"commons.wikimedia.org", "ru.wikipedia.org", "en.wikipedia.org"}
_BAD_IMAGE_WORDS = (
    "map", "plan", "diagram", "scheme", "logo", "icon", "flag",
    "coat of arms", "symbol", "drawing", "chart", "locator",
)
WALK_SPEED_KMH = 4.5  # Средняя скорость пешей прогулки для запасного расчёта
# Защита от гигантских запросов: пеший маршрут на 150+ км бессмысленен,
# а Overpass на такой прямоугольник может отвечать очень долго.
MAX_BBOX_DIAGONAL_KM = float(os.getenv("MAX_BBOX_DIAGONAL_KM", "150"))

CATEGORY_LABELS = {
    "art": "Искусство и галереи",
    "tourism_view": "Достопримечательности и виды",
    "culture": "Музеи и культура",
    "historic": "История и памятники",
    "nature": "Парки и природа",
    "urban": "Город и архитектура",
    "worship": "Храмы и культовые места",
}


class ApiError(Exception):
    """Ожидаемая ошибка API: отдаётся клиенту как JSON с понятным текстом."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# --- 0. ВАЛИДАЦИЯ ВХОДНЫХ ДАННЫХ ---

def _json_body() -> dict:
    data = request.get_json(silent=True)
    if data is None:
        if request.data:
            raise ApiError("Некорректный JSON в запросе")
        return {}
    if not isinstance(data, dict):
        raise ApiError("Тело запроса должно быть JSON-объектом")
    return data


def _finite_float(
    value,
    field: str,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
    default: float | None = None,
) -> float:
    if value is None:
        if default is not None:
            return default
        raise ApiError(f"Поле «{field}» обязательно")
    if isinstance(value, bool):
        raise ApiError(f"Поле «{field}» должно быть числом")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ApiError(f"Поле «{field}» должно быть числом") from None
    if not math.isfinite(number):
        raise ApiError(f"Поле «{field}» должно быть конечным числом")
    if minimum is not None and number < minimum:
        raise ApiError(f"Поле «{field}» должно быть не меньше {minimum}")
    if maximum is not None and number > maximum:
        raise ApiError(f"Поле «{field}» должно быть не больше {maximum}")
    return number


def _point_from_payload(value, field: str) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ApiError(f"Поле «{field}» должно быть объектом с lat и lon")
    return {
        "lat": _finite_float(value.get("lat"), f"{field}.lat", minimum=-90, maximum=90),
        "lon": _finite_float(value.get("lon"), f"{field}.lon", minimum=-180, maximum=180),
    }


def _resolve_points(data: dict) -> tuple[dict | None, dict | None]:
    """
    Берём точки из запроса, а если их там нет — из общего состояния.
    Это позволяет нескольким пользователям работать одновременно:
    новый фронтенд всегда присылает свои точки.
    """
    with state_lock:
        a, b = point_a, point_b

    if "point_a" in data:
        a = _point_from_payload(data.get("point_a"), "point_a")
    if "point_b" in data:
        b = _point_from_payload(data.get("point_b"), "point_b")
    return a, b


def _bbox_key(bbox: dict) -> tuple:
    return tuple(round(float(bbox[k]), 5) for k in ("south", "west", "north", "east"))


# --- 1. РАССТОЯНИЯ И АЛГОРИТМ ПОДБОРА ОСТАНОВОК ---

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Расстояние между двумя точками на Земле в километрах."""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    a = min(1.0, max(0.0, a))
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def path_length_km(coords: list[tuple[float, float]]) -> float:
    """Суммарная длина ломаной по списку координат [(lat, lon), ...]."""
    return sum(
        haversine_km(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
        for i in range(len(coords) - 1)
    )


def build_interesting_route_stops(
    point_a: tuple[float, float],
    point_b: tuple[float, float],
    places: list[dict],
    priority_categories: list[str] | None = None,
    max_stops: int = 3,
    max_detour_km: float = 0.8,
) -> list[dict]:
    """
    Подбирает и упорядочивает промежуточные места для пешего пути от A до B:
    - отсекает точки со слишком большим лишним «крюком» относительно прямой A -> B;
    - учитывает приоритетные категории;
    - вставляет каждую выбранную точку в позицию с минимальным приростом длины пути.

    Алгоритм остался прежним, но прирост длины теперь считается локально
    (по соседям точки вставки), а не пересчётом всего маршрута для каждого
    кандидата. На больших выгрузках это ускоряет работу в десятки раз.
    """
    max_stops = max(0, min(100, int(max_stops)))
    if max_stops <= 0 or not places:
        return []

    priority_categories = priority_categories or []
    direct_ab = haversine_km(point_a[0], point_a[1], point_b[0], point_b[1])

    cat_bonus = {
        cat: max(0.0, (len(priority_categories) - idx) * 0.2)
        for idx, cat in enumerate(priority_categories)
    }

    candidates = []
    seen_names = set()

    for p in places:
        name = p.get("name")
        if not name or name in seen_names:
            continue

        try:
            p_coord = (float(p["lat"]), float(p["lon"]))
        except (KeyError, TypeError, ValueError):
            continue
        if not (math.isfinite(p_coord[0]) and math.isfinite(p_coord[1])):
            continue

        detour = (
            haversine_km(point_a[0], point_a[1], p_coord[0], p_coord[1])
            + haversine_km(p_coord[0], p_coord[1], point_b[0], point_b[1])
            - direct_ab
        )

        if detour <= max_detour_km:
            bonus = cat_bonus.get(p.get("category", ""), 0.0)
            candidates.append((detour - bonus, p, p_coord))
            seen_names.add(name)

    candidates.sort(key=lambda item: item[0])

    route_nodes = [
        {"coord": point_a, "place": None},
        {"coord": point_b, "place": None},
    ]
    route_coords = [point_a, point_b]
    base_len = path_length_km(route_coords)

    for _, place, p_coord in candidates:
        if len(route_nodes) - 2 >= max_stops:
            break

        # Прирост длины при вставке p между coords[pos-1] и coords[pos].
        best_pos = None
        best_extra_km = float("inf")
        for pos in range(1, len(route_coords)):
            prev_coord = route_coords[pos - 1]
            next_coord = route_coords[pos]
            extra_km = (
                haversine_km(prev_coord[0], prev_coord[1], p_coord[0], p_coord[1])
                + haversine_km(p_coord[0], p_coord[1], next_coord[0], next_coord[1])
                - haversine_km(prev_coord[0], prev_coord[1], next_coord[0], next_coord[1])
            )
            if extra_km < best_extra_km:
                best_extra_km = extra_km
                best_pos = pos

        if best_pos is not None:
            current_detour = base_len + best_extra_km - direct_ab
            if current_detour <= max_detour_km:
                route_nodes.insert(best_pos, {"coord": p_coord, "place": place})
                route_coords.insert(best_pos, p_coord)
                base_len += best_extra_km

    return [n["place"] for n in route_nodes if n["place"] is not None]


def _split_waypoints(waypoints: list[tuple[float, float]], size: int) -> list[list[tuple[float, float]]]:
    """Режет длинный маршрут на куски по size точек с общей граничной точкой."""
    if len(waypoints) <= size:
        return [waypoints]

    chunks = []
    start = 0
    while start < len(waypoints) - 1:
        chunk = waypoints[start:start + size]
        chunks.append(chunk)
        start += size - 1
    return chunks


def _dedupe_consecutive(waypoints: list[tuple[float, float]]) -> list[tuple[float, float]]:
    cleaned: list[tuple[float, float]] = []
    for lat, lon in waypoints:
        if not (math.isfinite(lat) and math.isfinite(lon)):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        if cleaned and abs(cleaned[-1][0] - lat) < 1e-7 and abs(cleaned[-1][1] - lon) < 1e-7:
            continue
        cleaned.append((lat, lon))
    return cleaned


def _parse_route_steps(route: dict) -> list[dict]:
    """Достаёт из ответа OSRM последовательность манёвров для навигации."""
    legs = route.get("legs")
    if not isinstance(legs, list):
        return []

    combined: list[dict] = []
    for leg_index, leg in enumerate(legs):
        if not isinstance(leg, dict):
            continue
        raw_steps = leg.get("steps")
        if not isinstance(raw_steps, list):
            continue

        parsed: list[dict] = []
        for step in raw_steps:
            if not isinstance(step, dict):
                continue
            maneuver = step.get("maneuver") if isinstance(step.get("maneuver"), dict) else {}
            location = maneuver.get("location")
            if not isinstance(location, (list, tuple)) or len(location) < 2:
                continue
            try:
                lat = float(location[1])
                lon = float(location[0])
                distance_m = max(0.0, float(step.get("distance") or 0))
                duration_s = max(0.0, float(step.get("duration") or 0))
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(lat) and math.isfinite(lon)):
                continue

            parsed.append(
                {
                    "type": str(maneuver.get("type") or "continue")[:40],
                    "modifier": str(maneuver.get("modifier") or "")[:40],
                    "name": str(step.get("name") or "")[:200],
                    "distance_m": round(distance_m, 1),
                    "duration_s": round(duration_s, 1),
                    "location": [lat, lon],
                    "exit": maneuver.get("exit"),
                }
            )

        for index, step in enumerate(parsed):
            if leg_index > 0 and index == 0 and step["type"] == "depart":
                step = {**step, "type": "continue", "modifier": "straight"}
            if leg_index < len(legs) - 1 and index == len(parsed) - 1 and step["type"] == "arrive":
                continue
            combined.append(step)

    return combined


def _request_route_chunk(
    base_url: str,
    chunk: list[tuple[float, float]],
    session: requests.Session,
) -> dict | None:
    coords_str = ";".join(f"{lon},{lat}" for lat, lon in chunk)
    url = f"{base_url}/{coords_str}?overview=full&geometries=geojson&steps=true"
    try:
        resp = session.get(url, timeout=(4, ROUTING_TIMEOUT))
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:
        print(f"Ошибка маршрутизации через {base_url}: {exc}")
        return None

    if data.get("code") != "Ok" or not data.get("routes"):
        return None

    try:
        route = data["routes"][0]
        geometry = route["geometry"]["coordinates"]
        latlon_coords = []
        for pt in geometry:
            if len(pt) < 2:
                continue
            lat, lon = float(pt[1]), float(pt[0])
            if math.isfinite(lat) and math.isfinite(lon):
                latlon_coords.append([lat, lon])
        distance_km = float(route["distance"]) / 1000.0
        duration_s = float(route.get("duration") or 0)
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        print(f"Некорректный ответ маршрутизатора {base_url}: {exc}")
        return None

    if (
        len(latlon_coords) < 2
        or not math.isfinite(distance_km)
        or distance_km < 0
        or not math.isfinite(duration_s)
        or duration_s < 0
    ):
        return None

    return {
        "geometry": latlon_coords,
        "distance_km": distance_km,
        "duration_s": duration_s,
        "steps": _parse_route_steps(route),
        "provider": base_url,
    }


def build_walking_route_geometry(waypoints: list[tuple[float, float]]) -> dict:
    """
    Строит пеший маршрут по тротуарам/пешеходным дорожкам через routed-foot,
    с резервом на router.project-osrm.org и запасной ломаной линией.
    Длинные списки точек режутся на куски, чтобы не превышать лимит OSRM.
    """
    cleaned = _dedupe_consecutive([(float(lat), float(lon)) for lat, lon in waypoints])
    if len(cleaned) < 2:
        return {
            "mode": "foot",
            "provider": "empty",
            "geometry": [[lat, lon] for lat, lon in cleaned],
            "distance_km": 0.0,
            "duration_min": 0.0,
            "steps": [],
            "fallback": True,
        }

    chunks = _split_waypoints(cleaned, ROUTE_MAX_WAYPOINTS)
    session = requests.Session()
    session.headers.update({"User-Agent": f"{APP_NAME}/2.0", "Accept": "application/json"})
    deadline = time.monotonic() + ROUTING_TOTAL_BUDGET

    combined_geometry: list[list[float]] = []
    chunk_steps: list[list[dict]] = []
    total_distance_km = 0.0
    total_duration_s = 0.0
    providers: list[str] = []

    routing_ok = True
    for chunk in chunks:
        chunk_result = None
        for base_url in FOOT_ROUTING_URLS:
            if time.monotonic() >= deadline:
                break
            chunk_result = _request_route_chunk(base_url, chunk, session)
            if chunk_result:
                break
        if not chunk_result:
            routing_ok = False
            break

        geom = chunk_result["geometry"]
        if combined_geometry and geom:
            # Первая точка куска совпадает с последней точкой предыдущего.
            if combined_geometry[-1] == geom[0]:
                geom = geom[1:]
        combined_geometry.extend(geom)
        chunk_steps.append(chunk_result.get("steps") or [])
        total_distance_km += chunk_result["distance_km"]
        total_duration_s += chunk_result["duration_s"]
        providers.append(chunk_result["provider"])

    session.close()

    if not routing_ok or len(combined_geometry) < 2:
        total_km = round(path_length_km(cleaned), 2)
        return {
            "mode": "foot",
            "provider": "fallback_straight_segments",
            "providers": [],
            "geometry": [[lat, lon] for lat, lon in cleaned],
            "distance_km": total_km,
            "duration_min": round((total_km / WALK_SPEED_KMH) * 60.0, 1),
            "steps": [],
            "fallback": True,
        }

    combined_steps: list[dict] = []
    for index, steps in enumerate(chunk_steps):
        current = [dict(step) for step in steps]
        if index > 0 and current and current[0].get("type") == "depart":
            current[0] = {**current[0], "type": "continue", "modifier": "straight"}
        if index < len(chunk_steps) - 1 and current and current[-1].get("type") == "arrive":
            current = current[:-1]
        combined_steps.extend(current)

    distance_km = round(total_distance_km, 2)
    duration_min = (
        round(total_duration_s / 60.0, 1)
        if total_duration_s > 0
        else round((distance_km / WALK_SPEED_KMH) * 60.0, 1)
    )
    return {
        "mode": "foot",
        "provider": providers[0] if providers else "osrm",
        "providers": sorted(set(providers)),
        "geometry": combined_geometry,
        "distance_km": distance_km,
        "duration_min": duration_min,
        "steps": combined_steps,
        "fallback": False,
    }


# --- 2. КАТЕГОРИИ, BBOX, OVERPASS И ЛОКАЛЬНЫЙ ФОЛБЭК ПО САРАТОВУ ---

def detect_place_category(tags: dict) -> str:
    """Определяет категорию места по тегам OpenStreetMap."""
    if (
        tags.get("tourism") in {"artwork", "gallery"}
        or "artwork_type" in tags
        or tags.get("amenity") == "arts_centre"
        or tags.get("man_made") in {"sculpture", "statue"}
    ):
        return "art"
    if tags.get("tourism") in {"attraction", "viewpoint", "theme_park", "zoo", "aquarium"}:
        return "tourism_view"
    if tags.get("tourism") == "museum" or tags.get("amenity") in {
        "theatre",
        "cinema",
        "library",
        "planetarium",
        "community_centre",
    }:
        return "culture"
    if "historic" in tags or "memorial" in tags or tags.get("man_made") in {"obelisk", "monument"}:
        return "historic"
    if tags.get("leisure") in {"park", "garden", "nature_reserve", "dog_park"} or tags.get("natural") in {
        "peak",
        "cave_entrance",
        "spring",
        "beach",
        "cliff",
    }:
        return "nature"
    if tags.get("amenity") == "place_of_worship" or tags.get("building") in {
        "church",
        "cathedral",
        "mosque",
        "synagogue",
        "chapel",
    }:
        return "worship"
    if (
        tags.get("amenity") in {"fountain", "clock", "townhall", "courthouse"}
        or tags.get("building") in {"castle", "palace", "civic"}
        or tags.get("man_made") in {"lighthouse", "windmill", "tower", "pier", "bridge"}
    ):
        return "urban"
    return "tourism_view"


def _parse_categories_param(data: dict) -> tuple[list[str], bool]:
    """
    Возвращает (список_выбранных_категорий, передан_ли_фильтр_явно).
    Если ключ 'categories' отсутствует в JSON — фильтр не задан (берём все категории).
    Если ключ 'categories' передан как [] — пользователь снял все галочки (результат пуст).
    """
    if "categories" not in data or data.get("categories") is None:
        return list(CATEGORY_LABELS.keys()), False

    raw_cats = data.get("categories")
    if not isinstance(raw_cats, list):
        return list(CATEGORY_LABELS.keys()), False

    valid = [c for c in raw_cats if isinstance(c, str) and c in CATEGORY_LABELS]
    return valid, True


def _parse_priority_categories(data: dict, selected: list[str]) -> list[str]:
    raw = data.get("priority_categories")
    if not isinstance(raw, list):
        return list(selected)
    valid = [c for c in raw if isinstance(c, str) and c in CATEGORY_LABELS]
    return valid or list(selected)


def filter_places_by_categories(
    places: list[dict],
    selected_categories: list[str],
    filter_explicitly_set: bool = True,
) -> list[dict]:
    """Фильтрует список мест по выбранным категориям."""
    if not filter_explicitly_set:
        return list(places)
    if not selected_categories:
        return []
    allowed = set(selected_categories)
    return [p for p in places if p.get("category") in allowed]


def build_bbox(pt_a: dict, pt_b: dict, pad: float = 0.015) -> dict:
    """Строит прямоугольник (south, west, north, east) вокруг точек A и B с отступом pad."""
    pad = max(0.0, min(0.5, float(pad)))
    south = min(pt_a["lat"], pt_b["lat"]) - pad
    north = max(pt_a["lat"], pt_b["lat"]) + pad
    west = min(pt_a["lon"], pt_b["lon"]) - pad
    east = max(pt_a["lon"], pt_b["lon"]) + pad
    return {
        "south": round(max(-90.0, south), 6),
        "west": round(max(-180.0, west), 6),
        "north": round(min(90.0, north), 6),
        "east": round(min(180.0, east), 6),
    }


def _validate_bbox_size(bbox: dict) -> None:
    """Не даём одним запросом выгрузить полмира из Overpass."""
    diagonal = haversine_km(bbox["south"], bbox["west"], bbox["north"], bbox["east"])
    if diagonal > MAX_BBOX_DIAGONAL_KM:
        raise ApiError(
            f"Слишком большая область ({diagonal:.0f} км). "
            f"Выберите точки ближе друг к другу (до {MAX_BBOX_DIAGONAL_KM:.0f} км)."
        )


def _extract_lat_lon_from_geometry(geometry: dict | None) -> tuple[float | None, float | None]:
    """Извлекает (lat, lon) из GeoJSON geometry (Point, Polygon, MultiPolygon и др.)."""
    if not geometry:
        return None, None

    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return None, None

    try:
        if geom_type == "Point" and len(coords) >= 2:
            if isinstance(coords[0], bool) or isinstance(coords[1], bool):
                return None, None
            lat, lon = float(coords[1]), float(coords[0])
            if math.isfinite(lat) and math.isfinite(lon):
                return lat, lon
            return None, None
    except (TypeError, ValueError):
        return None, None

    points: list[tuple[float, float]] = []

    def collect(node):
        if isinstance(node, (list, tuple)):
            if len(node) >= 2 and isinstance(node[0], (int, float)) and isinstance(node[1], (int, float)):
                if not isinstance(node[0], bool) and not isinstance(node[1], bool):
                    lat, lon = float(node[1]), float(node[0])
                    if math.isfinite(lat) and math.isfinite(lon):
                        points.append((lat, lon))
            else:
                for item in node:
                    collect(item)

    try:
        collect(coords)
    except (TypeError, ValueError):
        return None, None
    if not points:
        return None, None

    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def _place_from_tags(tags: dict, lat, lon, place_id=None) -> dict | None:
    """Собирает нормализованное место из тегов OSM. Возвращает None, если нет имени."""
    if not isinstance(tags, dict):
        return None
    name = tags.get("name") or tags.get("name:ru") or tags.get("name:en")
    if not name:
        return None
    name = str(name).strip()
    if not name:
        return None
    if isinstance(lat, bool) or isinstance(lon, bool):
        return None
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
        return None
    if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180):
        return None

    category = detect_place_category(tags)
    return {
        "id": place_id,
        "name": name[:300],
        "category": category,
        "category_label": CATEGORY_LABELS.get(category, category),
        "lat": lat_f,
        "lon": lon_f,
    }


def _get_saratov_places_from_geojson() -> list[dict]:
    """Читает и кэширует в памяти объекты из saratov.geojson (или готового JSON-списка)."""
    global _saratov_places_cache, _saratov_coverage, _saratov_mtime

    try:
        mtime = SARATOV_GEOJSON_FILE.stat().st_mtime
    except OSError:
        raise FileNotFoundError(
            f"Файл {SARATOV_GEOJSON_FILE.name} не найден рядом с app.py. "
            "Положите выгрузку overpass-turbo (GeoJSON) в папку проекта."
        ) from None

    with _geojson_lock:
        if _saratov_places_cache is not None and _saratov_mtime == mtime:
            return _saratov_places_cache

        try:
            raw = json.loads(SARATOV_GEOJSON_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Не удалось прочитать {SARATOV_GEOJSON_FILE.name}: {exc}") from exc

        parsed: list[dict] = []

        if isinstance(raw, dict) and "features" in raw:
            for feat in raw.get("features", []):
                if not isinstance(feat, dict):
                    continue
                props = feat.get("properties") or {}
                if not isinstance(props, dict):
                    props = {}
                tags = props.get("tags") if isinstance(props.get("tags"), dict) else props
                lat, lon = _extract_lat_lon_from_geometry(feat.get("geometry"))
                if lat is None or lon is None:
                    continue
                place = _place_from_tags(
                    tags,
                    lat,
                    lon,
                    props.get("@id") or feat.get("id") or tags.get("id"),
                )
                if place:
                    parsed.append(place)

        elif isinstance(raw, dict) and "elements" in raw:
            for el in raw.get("elements", []):
                if not isinstance(el, dict):
                    continue
                tags = el.get("tags", {})
                center = el.get("center") or {}
                lat = el.get("lat") if "lat" in el else center.get("lat")
                lon = el.get("lon") if "lon" in el else center.get("lon")
                place = _place_from_tags(tags, lat, lon, el.get("id"))
                if place:
                    parsed.append(place)

        elif isinstance(raw, list):
            for p in raw:
                if not isinstance(p, dict):
                    continue
                place = _place_from_tags(
                    p,
                    p.get("lat"),
                    p.get("lon"),
                    p.get("id"),
                )
                if place:
                    place["category"] = p.get("category") if p.get("category") in CATEGORY_LABELS else place["category"]
                    place["category_label"] = CATEGORY_LABELS.get(place["category"], place["category"])
                    parsed.append(place)

        else:
            raise RuntimeError(
                f"{SARATOV_GEOJSON_FILE.name}: ожидался GeoJSON FeatureCollection, "
                "ответ Overpass с elements или JSON-массив мест."
            )

        _saratov_places_cache = parsed
        _saratov_mtime = mtime

        if parsed:
            _saratov_coverage = {
                "south": min(p["lat"] for p in parsed),
                "west": min(p["lon"] for p in parsed),
                "north": max(p["lat"] for p in parsed),
                "east": max(p["lon"] for p in parsed),
                "count": len(parsed),
            }
        else:
            _saratov_coverage = None

        return parsed


def get_local_coverage() -> dict | None:
    _get_saratov_places_from_geojson()
    return _saratov_coverage


def load_saratov_fallback_in_bbox(south: float, west: float, north: float, east: float) -> list[dict]:
    """Фильтрует локальные достопримечательности Саратова по текущему BBox."""
    all_places = _get_saratov_places_from_geojson()
    return [
        p for p in all_places
        if south <= p["lat"] <= north and west <= p["lon"] <= east
    ]


def _overpass_query(bbox: dict) -> str:
    box = f"{bbox['south']},{bbox['west']},{bbox['north']},{bbox['east']}"
    return f"""
    [out:json][timeout:{OVERPASS_QUERY_TIMEOUT}][maxsize:33554432];

    (
      nwr["tourism"~"artwork|attraction|museum|viewpoint|gallery|theme_park|zoo|aquarium"]({box});
      nwr["artwork_type"]({box});
      nwr["historic"]({box});
      nwr["memorial"]({box});
      nwr["leisure"~"park|garden|nature_reserve|dog_park"]({box});
      nwr["natural"~"peak|cave_entrance|spring|beach|cliff"]({box});
      nwr["amenity"~"fountain|theatre|arts_centre|library|planetarium|clock|cinema|community_centre|place_of_worship|townhall|courthouse"]({box});
      nwr["building"~"church|cathedral|mosque|synagogue|chapel|castle|palace|civic"]({box});
      nwr["man_made"~"lighthouse|windmill|tower|pier|bridge|sculpture|statue|obelisk|monument"]({box});
    );

    out center;
    """


def _overpass_worker(url: str, query: str) -> list[dict]:
    headers = dict(OVERPASS_HEADERS)
    if "overpass-turbo.eu" in url:
        headers["Origin"] = "https://overpass-turbo.eu"
        headers["Referer"] = "https://overpass-turbo.eu/"

    resp = requests.post(
        url,
        data={"data": query},
        headers=headers,
        timeout=(4, OVERPASS_READ_TIMEOUT),
    )
    resp.raise_for_status()

    raw_text = resp.text.strip()
    if not raw_text:
        raise ValueError("пустой ответ")

    try:
        payload = resp.json()
    except ValueError:
        snippet = " ".join(raw_text[:120].split())
        raise ValueError(f"ответ не JSON: {snippet}") from None

    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise ValueError("в ответе нет списка elements")
    return elements


def _overpass_request(query: str, force: bool = False) -> tuple[list[dict], str]:
    """
    Опрашивает зеркала Overpass параллельно и берёт первый успешный ответ.
    Упавшие зеркала временно исключаются, чтобы локальный фолбэк
    срабатывал быстро, а не через 100 секунд.
    """
    now = time.monotonic()
    with _overpass_guard_lock:
        candidates = [
            url for url in OVERPASS_URLS
            if force or _overpass_failed_until.get(url, 0.0) <= now
        ]

    if not candidates:
        raise RuntimeError("все зеркала Overpass недавно не отвечали")

    executor = ThreadPoolExecutor(max_workers=len(candidates), thread_name_prefix="overpass")
    futures = {
        executor.submit(_overpass_worker, url, query): url
        for url in candidates
    }
    errors: list[str] = []
    succeeded = False

    try:
        for future in as_completed(futures, timeout=OVERPASS_READ_TIMEOUT + 2):
            url = futures[future]
            try:
                elements = future.result()
            except Exception as exc:
                with _overpass_guard_lock:
                    _overpass_failed_until[url] = time.monotonic() + OVERPASS_COOLDOWN
                errors.append(f"{urlparse(url).netloc}: {exc}")
                continue

            with _overpass_guard_lock:
                _overpass_failed_until.pop(url, None)
            succeeded = True
            return elements, url
    except TimeoutError:
        errors.append(f"таймаут {OVERPASS_READ_TIMEOUT + 2:.0f} с")
    finally:
        if not succeeded:
            for future, url in futures.items():
                if not future.done():
                    future.cancel()
                with _overpass_guard_lock:
                    _overpass_failed_until[url] = time.monotonic() + OVERPASS_COOLDOWN
        executor.shutdown(wait=False)

    raise RuntimeError("; ".join(errors) if errors else "Overpass недоступен")


def _places_from_overpass(elements: list[dict]) -> list[dict]:
    places: list[dict] = []
    seen_ids = set()
    for el in elements:
        if not isinstance(el, dict):
            continue
        el_id = el.get("id")
        el_type = el.get("type")
        unique_id = f"{el_type}/{el_id}" if el_id is not None else None
        if unique_id is not None and unique_id in seen_ids:
            continue
        tags = el.get("tags", {})
        center = el.get("center") or {}
        lat = el.get("lat") if "lat" in el else center.get("lat")
        lon = el.get("lon") if "lon" in el else center.get("lon")
        place = _place_from_tags(tags, lat, lon, unique_id or el_id)
        if place:
            places.append(place)
            if unique_id is not None:
                seen_ids.add(unique_id)
    return places


def _cache_get(key: tuple) -> dict | None:
    with _places_cache_lock:
        entry = _places_cache.get(key)
        if not entry:
            return None
        ttl = CACHE_TTL_LIVE if entry["source"] == "overpass-turbo" else CACHE_TTL_LOCAL
        if time.monotonic() - entry["ts"] > ttl:
            _places_cache.pop(key, None)
            return None
        return {
            "places": list(entry["places"]),
            "source": entry["source"],
            "meta": dict(entry["meta"]),
        }


def _cache_put(key: tuple, places: list[dict], source: str, meta: dict) -> None:
    with _places_cache_lock:
        if len(_places_cache) >= PLACES_CACHE_MAX:
            oldest = min(_places_cache.items(), key=lambda item: item[1]["ts"])[0]
            _places_cache.pop(oldest, None)
        _places_cache[key] = {
            "ts": time.monotonic(),
            "places": list(places),
            "source": source,
            "meta": dict(meta),
        }


def _bbox_outside_coverage(bbox: dict, coverage: dict | None) -> bool:
    if not coverage:
        return True
    return (
        bbox["north"] < coverage["south"]
        or bbox["south"] > coverage["north"]
        or bbox["east"] < coverage["west"]
        or bbox["west"] > coverage["east"]
    )


def _source_notice(source: str, meta: dict, bbox: dict) -> str | None:
    if source == "overpass-turbo":
        return None
    if _bbox_outside_coverage(bbox, meta.get("coverage")):
        return (
            "Overpass сейчас недоступен. Локальный набор содержит только Саратов, "
            "а выбранная область находится за его пределами — мест не найдено. "
            "Попробуйте «Повторить» позже или выберите точки в Саратове."
        )
    return (
        "Overpass сейчас недоступен — показан локальный набор мест Саратова. "
        "Когда сервис заработает, нажмите «Повторить»."
    )


def fetch_places_in_bbox(
    south: float,
    west: float,
    north: float,
    east: float,
    *,
    force: bool = False,
) -> tuple[list[dict], str, dict]:
    """
    Ищет места в Overpass; если API недоступно — переключается на локальный
    GeoJSON Саратова. Источники НЕ смешиваются, поэтому при восстановлении
    Overpass дубликатов и конфликтов не будет — локальные данные просто
    перестанут использоваться.
    """
    bbox = {"south": south, "west": west, "north": north, "east": east}
    key = _bbox_key(bbox)

    if not force:
        cached = _cache_get(key)
        if cached:
            return cached["places"], cached["source"], cached["meta"]

    query = _overpass_query(bbox)
    live_error = None
    try:
        elements, provider = _overpass_request(query, force=force)
        places = _places_from_overpass(elements)
        source = "overpass-turbo"
        meta = {
            "provider": provider,
            "fallback": False,
            "error": None,
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        live_error = str(exc)
        print(f"Overpass недоступен ({live_error}), переключаемся на saratov.geojson...")
        try:
            places = load_saratov_fallback_in_bbox(south, west, north, east)
        except Exception as local_err:
            raise RuntimeError(
                f"Overpass недоступен ({live_error}); локальный файл тоже не прочитан: {local_err}"
            ) from local_err

        source = "local_saratov_geojson"
        meta = {
            "provider": "saratov.geojson",
            "fallback": True,
            "error": live_error[:500],
            "coverage": get_local_coverage(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
        }

    _cache_put(key, places, source, meta)
    return places, source, meta


# --- 2b. ФОТОГРАФИИ ИЗ WIKIMEDIA ---

def _strip_html(value) -> str:
    text = html_lib.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_safe_https_url(value, hosts: set[str]) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme == "https" and parsed.hostname in hosts


def _optional_coordinate(value, minimum: float, maximum: float) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or not (minimum <= number <= maximum):
        return None
    return number


def _wikimedia_api(host: str, params: dict) -> dict:
    response = requests.get(
        f"https://{host}/w/api.php",
        params={**params, "format": "json", "formatversion": "2"},
        headers={
            "User-Agent": WIKIMEDIA_USER_AGENT,
            "Accept": "application/json",
        },
        timeout=(3.5, WIKIMEDIA_TIMEOUT),
    )
    response.raise_for_status()
    data = response.json()
    return data if isinstance(data, dict) else {}


def _image_from_commons_page(page: dict) -> dict | None:
    infos = page.get("imageinfo") or []
    if not isinstance(infos, list) or not infos:
        return None
    info = infos[0]
    if not isinstance(info, dict):
        return None

    mime = str(info.get("mime") or "")
    if mime not in {"image/jpeg", "image/png", "image/webp"}:
        return None

    try:
        width = int(info.get("width") or 0)
        height = int(info.get("height") or 0)
    except (TypeError, ValueError):
        width = height = 0
    if width < 400 or height < 240:
        return None

    title = str(page.get("title") or "")
    title_lower = title.casefold()
    if any(word in title_lower for word in _BAD_IMAGE_WORDS):
        return None

    image_url = info.get("thumburl") or info.get("url")
    if not _is_safe_https_url(image_url, _IMAGE_HOSTS):
        return None

    page_url = info.get("descriptionurl") or page.get("descriptionurl")
    if not _is_safe_https_url(page_url, _PAGE_HOSTS):
        page_url = None

    ext = info.get("extmetadata") if isinstance(info.get("extmetadata"), dict) else {}

    def meta(name: str) -> str:
        item = ext.get(name)
        return _strip_html(item.get("value")) if isinstance(item, dict) else ""

    return {
        "url": image_url,
        "page_url": page_url,
        "title": title.removeprefix("File:")[:200],
        "source": "Wikimedia Commons",
        "artist": meta("Artist")[:140],
        "license": meta("LicenseShortName")[:80],
    }


def _pages_from_response(data: dict) -> list[dict]:
    query = data.get("query") if isinstance(data.get("query"), dict) else {}
    pages = query.get("pages") or []
    if isinstance(pages, dict):
        pages = list(pages.values())
    return [page for page in pages if isinstance(page, dict)]


def _commons_geosearch(lat: float, lon: float) -> dict | None:
    data = _wikimedia_api(
        "commons.wikimedia.org",
        {
            "action": "query",
            "generator": "geosearch",
            "ggscoord": f"{lat}|{lon}",
            "ggsradius": "250",
            "ggslimit": "15",
            "ggsnamespace": "6",
            "prop": "imageinfo",
            "iiprop": "url|mime|size|extmetadata",
            "iiurlwidth": "480",
            "iiextmetadatafilter": "Artist|LicenseShortName",
        },
    )
    pages = _pages_from_response(data)
    pages.sort(
        key=lambda page: page.get("dist")
        if isinstance(page.get("dist"), (int, float))
        else 1e9
    )
    for page in pages:
        image = _image_from_commons_page(page)
        if image:
            return image
    return None


def _commons_name_search(name: str) -> dict | None:
    if len(name.strip()) < 4:
        return None
    data = _wikimedia_api(
        "commons.wikimedia.org",
        {
            "action": "query",
            "generator": "search",
            "gsrsearch": f"{name} filetype:bitmap",
            "gsrnamespace": "6",
            "gsrlimit": "8",
            "prop": "imageinfo",
            "iiprop": "url|mime|size|extmetadata",
            "iiurlwidth": "480",
            "iiextmetadatafilter": "Artist|LicenseShortName",
        },
    )
    for page in _pages_from_response(data):
        image = _image_from_commons_page(page)
        if image:
            return image
    return None


def _wikipedia_search(name: str) -> dict | None:
    if len(name.strip()) < 4:
        return None

    data = _wikimedia_api(
        "ru.wikipedia.org",
        {
            "action": "query",
            "generator": "search",
            "gsrsearch": name,
            "gsrnamespace": "0",
            "gsrlimit": "3",
            "prop": "pageimages|info|pageprops",
            "piprop": "thumbnail|name",
            "pithumbsize": "480",
            "pilicense": "free",
            "inprop": "url",
            "redirects": "1",
        },
    )

    tokens = [token for token in re.split(r"[^\w]+", name.casefold()) if len(token) >= 3]
    for page in _pages_from_response(data):
        props = page.get("pageprops")
        if isinstance(props, dict) and "disambiguation" in props:
            continue

        title = str(page.get("title") or "")
        if tokens and not any(token in title.casefold() for token in tokens):
            continue

        thumbnail = page.get("thumbnail") if isinstance(page.get("thumbnail"), dict) else {}
        image_url = thumbnail.get("source")
        if not _is_safe_https_url(image_url, _IMAGE_HOSTS):
            continue

        page_url = page.get("fullurl")
        if not _is_safe_https_url(page_url, _PAGE_HOSTS):
            page_url = None

        return {
            "url": image_url,
            "page_url": page_url,
            "title": title[:200],
            "source": "Wikipedia",
            "artist": "",
            "license": "",
        }
    return None


def _image_cache_get(key: tuple) -> tuple[bool, dict | None]:
    with _image_cache_lock:
        entry = _image_cache.get(key)
        if not entry:
            return False, None
        ttl = IMAGE_CACHE_TTL if entry["image"] else IMAGE_NEGATIVE_TTL
        if time.monotonic() - entry["ts"] > ttl:
            _image_cache.pop(key, None)
            return False, None
        return True, entry["image"]


def _image_cache_put(key: tuple, image: dict | None) -> None:
    with _image_cache_lock:
        if len(_image_cache) >= IMAGE_CACHE_MAX:
            oldest = min(_image_cache.items(), key=lambda item: item[1]["ts"])[0]
            _image_cache.pop(oldest, None)
        _image_cache[key] = {"ts": time.monotonic(), "image": image}


def get_place_image(name: str, lat: float | None, lon: float | None) -> dict | None:
    name = (name or "").strip()[:300]
    key = (
        round(lat, 4) if lat is not None else None,
        round(lon, 4) if lon is not None else None,
        name.casefold(),
    )
    cached, image = _image_cache_get(key)
    if cached:
        return image

    result = None
    if lat is not None and lon is not None:
        try:
            result = _commons_geosearch(lat, lon)
        except Exception as exc:
            print(f"Wikimedia geosearch error: {exc}")

    if not result and name:
        try:
            result = _wikipedia_search(name)
        except Exception as exc:
            print(f"Wikipedia image error: {exc}")

    if not result and name:
        try:
            result = _commons_name_search(name)
        except Exception as exc:
            print(f"Wikimedia search error: {exc}")

    _image_cache_put(key, result)
    return result


# --- 3. РОУТЫ FLASK ---

@app.before_request
def _guard_mutating_requests():
    """Простая защита от CSRF: браузерные POST должны быть с нашего же origin."""
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
        return None
    if not request.path.startswith("/api/"):
        return None
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise ApiError("Запрос с другого сайта запрещён", 403)
    origin = request.headers.get("Origin")
    if origin == "null":
        raise ApiError("Запрос с другого сайта запрещён", 403)
    if origin:
        parsed = urlparse(origin)
        if parsed.netloc and parsed.netloc != request.host:
            raise ApiError("Запрос с другого сайта запрещён", 403)
    return None


@app.after_request
def _security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' data: https://*.tile.openstreetmap.org "
        "https://tile.openstreetmap.org https://upload.wikimedia.org "
        "https://thumb.wikimedia.org; "
        "connect-src 'self'; font-src 'self' data:; object-src 'none'; "
        "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
    )
    response.headers.setdefault("Permissions-Policy", "geolocation=(self)")
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(ApiError)
def _handle_api_error(err: ApiError):
    return jsonify({"error": err.message}), err.status


@app.errorhandler(413)
def _handle_too_large(_err):
    return jsonify({"error": "Слишком большой запрос"}), 413


@app.errorhandler(Exception)
def _handle_unexpected(err):
    if isinstance(err, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": err.description}), err.code or 500
        return err
    app.logger.exception("Необработанная ошибка")
    if request.path.startswith("/api/"):
        return jsonify({"error": "Внутренняя ошибка сервера"}), 500
    return "Внутренняя ошибка сервера", 500


def _points_payload() -> dict:
    with state_lock:
        return {
            "point_a": point_a,
            "point_b": point_b,
            "bbox": current_bbox,
            "places": list(found_places),
            "route_result": last_route_data,
            "categories": CATEGORY_LABELS,
        }


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/api/points", methods=["GET"])
def get_points():
    return jsonify(_points_payload())


@app.route("/api/points", methods=["POST"])
def save_points():
    global point_a, point_b, current_bbox, found_places, last_route_data
    global found_places_bbox_key, found_places_source, found_places_meta

    data = _json_body()

    reset = bool(data.get("reset"))

    if reset:
        with state_lock:
            point_a = None
            point_b = None
    elif "point_a" in data or "point_b" in data:
        # Явная передача точек — режим, который использует новый фронтенд.
        new_a = _point_from_payload(data.get("point_a"), "point_a")
        new_b = _point_from_payload(data.get("point_b"), "point_b")
        with state_lock:
            point_a = new_a
            point_b = new_b
    else:
        lat = _finite_float(data.get("lat"), "lat", minimum=-90, maximum=90)
        lon = _finite_float(data.get("lon"), "lon", minimum=-180, maximum=180)
        clicked = {"lat": lat, "lon": lon}

        with state_lock:
            # 1-й клик -> A, 2-й клик -> B, 3-й клик -> сброс старой пары и новая точка A
            if point_a is None or (point_a is not None and point_b is not None):
                point_a = clicked
                point_b = None
            else:
                point_b = clicked

    with state_lock:
        current_bbox = None
        found_places = []
        found_places_bbox_key = None
        found_places_source = None
        found_places_meta = {}
        last_route_data = None
        return jsonify({
            "point_a": point_a,
            "point_b": point_b,
        })


@app.route("/api/search-places", methods=["POST"])
def search_places():
    global current_bbox, found_places, last_route_data
    global found_places_bbox_key, found_places_source, found_places_meta

    data = _json_body()
    a, b = _resolve_points(data)
    if a is None or b is None:
        raise ApiError("Сначала поставьте на карте обе точки: A и B")

    pad = _finite_float(data.get("pad"), "pad", minimum=0.0, maximum=0.5, default=0.015)
    selected_categories, filter_set = _parse_categories_param(data)
    force_live = bool(data.get("force_live"))

    bbox = build_bbox(a, b, pad=pad)
    _validate_bbox_size(bbox)

    try:
        all_in_bbox, source, meta = fetch_places_in_bbox(
            bbox["south"],
            bbox["west"],
            bbox["north"],
            bbox["east"],
            force=force_live,
        )
    except Exception as exc:
        raise ApiError(f"Не удалось получить места: {exc}", 503) from exc

    filtered_places = filter_places_by_categories(
        all_in_bbox,
        selected_categories=selected_categories,
        filter_explicitly_set=filter_set,
    )

    with state_lock:
        current_bbox = bbox
        found_places = all_in_bbox
        found_places_bbox_key = _bbox_key(bbox)
        found_places_source = source
        found_places_meta = meta
        last_route_data = None

    return jsonify({
        "bbox": bbox,
        "source": source,
        "provider": meta.get("provider"),
        "provider_error": meta.get("error"),
        "fallback": source != "overpass-turbo",
        "notice": _source_notice(source, meta, bbox),
        "coverage": meta.get("coverage"),
        "total_in_bbox": len(all_in_bbox),
        "count": len(filtered_places),
        "categories": selected_categories,
        "places": filtered_places,
        # Для мгновенной локальной фильтрации по категориям без нового запроса.
        "all_places": all_in_bbox,
    })


@app.route("/api/place-image", methods=["GET"])
def place_image():
    name = (request.args.get("name") or "").strip()[:300]
    lat = _optional_coordinate(request.args.get("lat"), -90, 90)
    lon = _optional_coordinate(request.args.get("lon"), -180, 180)

    if lat is None or lon is None:
        lat = lon = None
    if not name and lat is None:
        return jsonify({"image": None})

    try:
        image = get_place_image(name, lat, lon)
    except Exception as exc:
        app.logger.warning("Не удалось получить фото места: %s", exc)
        image = None

    return jsonify({"image": image})


@app.route("/api/build-route", methods=["POST"])
def build_route():
    global current_bbox, found_places, last_route_data
    global found_places_bbox_key, found_places_source, found_places_meta

    data = _json_body()
    a, b = _resolve_points(data)
    if a is None or b is None:
        raise ApiError("Сначала поставьте на карте обе точки: A и B")

    pad = _finite_float(data.get("pad"), "pad", minimum=0.0, maximum=0.5, default=0.015)
    max_detour_km = _finite_float(
        data.get("max_detour_km"), "max_detour_km", minimum=0.02, maximum=20.0, default=0.8
    )
    max_stops_raw = data.get("max_stops", 3)
    max_stops = int(_finite_float(max_stops_raw, "max_stops", minimum=1, maximum=100, default=3))
    selected_categories, filter_set = _parse_categories_param(data)
    priority_categories = _parse_priority_categories(data, selected_categories)

    bbox = build_bbox(a, b, pad=pad)
    _validate_bbox_size(bbox)
    key = _bbox_key(bbox)

    with state_lock:
        cached_places = found_places
        cached_key = found_places_bbox_key
        cached_source = found_places_source
        cached_meta = dict(found_places_meta)
        last_route_data = None

    if cached_key == key and cached_source is not None:
        all_places = cached_places
        source = cached_source
        meta = cached_meta
    else:
        try:
            all_places, source, meta = fetch_places_in_bbox(
                bbox["south"],
                bbox["west"],
                bbox["north"],
                bbox["east"],
            )
        except Exception as exc:
            raise ApiError(f"Не удалось получить места: {exc}", 503) from exc
        with state_lock:
            current_bbox = bbox
            found_places = all_places
            found_places_bbox_key = key
            found_places_source = source
            found_places_meta = meta

    filtered_places = filter_places_by_categories(
        all_places,
        selected_categories=selected_categories,
        filter_explicitly_set=filter_set,
    )

    stops = build_interesting_route_stops(
        point_a=(a["lat"], a["lon"]),
        point_b=(b["lat"], b["lon"]),
        places=filtered_places,
        priority_categories=priority_categories,
        max_stops=max_stops,
        max_detour_km=max_detour_km,
    )

    waypoints = (
        [(a["lat"], a["lon"])]
        + [(s["lat"], s["lon"]) for s in stops]
        + [(b["lat"], b["lon"])]
    )
    route_geom = build_walking_route_geometry(waypoints)

    warnings: list[str] = []
    source_notice = _source_notice(source, meta, bbox)
    if source_notice:
        warnings.append(source_notice)
    if route_geom.get("fallback"):
        warnings.append(
            "Сервис пешей маршрутизации недоступен — линия маршрута показана прямыми отрезками."
        )

    route_data = {
        "stops": stops,
        "route": route_geom,
        "source": source,
        "provider": meta.get("provider"),
        "fallback": source != "overpass-turbo",
        "notice": source_notice,
        "warnings": warnings,
        "categories": selected_categories,
        "max_detour_km": max_detour_km,
        "max_stops": max_stops,
        "total_in_bbox": len(all_places),
    }

    with state_lock:
        last_route_data = route_data

    return jsonify(route_data)


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "").lower() in {"1", "true", "yes", "on"}

    # debug=True по умолчанию опасен: интерактивный отладчик позволяет
    # выполнять код на сервере при доступе извне.
    try:
        app.run(host=host, port=port, debug=debug, threaded=True)
    except OSError as exc:
        print(
            f"\nНе удалось запустить сервер на {host}:{port}: {exc}\n"
            "На macOS порт 5000 часто занят AirPlay Receiver (ControlCenter).\n"
            "Запустите с другим портом, например:\n"
            "    PORT=5050 python app.py\n"
        )
        raise SystemExit(1) from exc
