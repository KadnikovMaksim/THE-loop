import math
import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# --- СОСТОЯНИЕ НА СЕРВЕРЕ (В ПЕРЕМЕННЫХ) ---
point_a = None         # {"lat": float, "lon": float} | None
point_b = None         # {"lat": float, "lon": float} | None
current_bbox = None    # {"south": float, "west": float, "north": float, "east": float} | None
found_places = []      # список словарей найденных мест
last_route_data = None # последний построенный маршрут

# --- НАСТРОЙКИ ВНЕШНИХ СЕРВИСОВ ---
OVERPASS_URL = "https://api.overpass-turbo.eu/interpreter"
OVERPASS_HEADERS = {
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "Origin": "https://overpass-turbo.eu",
    "Referer": "https://overpass-turbo.eu/",
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 OPR/140.0.0.0"
    ),
}

FOOT_ROUTING_URLS = [
    "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
    "https://router.project-osrm.org/route/v1/foot",
]
WALK_SPEED_KMH = 4.5  # Средняя скорость пешей прогулки для запасного расчёта

CATEGORY_LABELS = {
    "art": "Искусство и галереи",
    "tourism_view": "Достопримечательности и виды",
    "culture": "Музеи и культура",
    "historic": "История и памятники",
    "nature": "Парки и природа",
    "urban": "Город и архитектура",
    "worship": "Храмы и культовые места",
}


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
    """
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

        p_coord = (float(p["lat"]), float(p["lon"]))
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

    for _, place, p_coord in candidates:
        if len(route_nodes) - 2 >= max_stops:
            break

        base_len = path_length_km([n["coord"] for n in route_nodes])
        best_pos = None
        best_extra_km = float("inf")

        for pos in range(1, len(route_nodes)):
            trial = [n["coord"] for n in route_nodes]
            trial.insert(pos, p_coord)
            extra_km = path_length_km(trial) - base_len

            if extra_km < best_extra_km:
                best_extra_km = extra_km
                best_pos = pos

        if best_pos is not None:
            trial_coords = (
                [n["coord"] for n in route_nodes[:best_pos]]
                + [p_coord]
                + [n["coord"] for n in route_nodes[best_pos:]]
            )
            current_detour = path_length_km(trial_coords) - direct_ab
            if current_detour <= max_detour_km:
                route_nodes.insert(best_pos, {"coord": p_coord, "place": place})

    return [n["place"] for n in route_nodes if n["place"] is not None]


def build_walking_route_geometry(waypoints: list[tuple[float, float]]) -> dict:
    """
    Строит пеший маршрут по тротуарам/пешеходным дорожкам через routed-foot,
    с резервом на router.project-osrm.org и запасной ломаной линией.
    """
    coords_str = ";".join(f"{lon},{lat}" for lat, lon in waypoints)

    for base_url in FOOT_ROUTING_URLS:
        url = f"{base_url}/{coords_str}?overview=full&geometries=geojson"
        try:
            resp = requests.get(url, timeout=12)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == "Ok" and data.get("routes"):
                route = data["routes"][0]
                latlon_coords = [[pt[1], pt[0]] for pt in route["geometry"]["coordinates"]]
                distance_km = round(route["distance"] / 1000.0, 2)
                duration_min = (
                    round(route["duration"] / 60.0, 1)
                    if route.get("duration")
                    else round((distance_km / WALK_SPEED_KMH) * 60.0, 1)
                )
                return {
                    "mode": "foot",
                    "provider": base_url,
                    "geometry": latlon_coords,
                    "distance_km": distance_km,
                    "duration_min": duration_min,
                    "fallback": False,
                }
        except Exception as e:
            print(f"Ошибка при запросе пешего маршрута к {base_url}: {e}")

    total_km = round(path_length_km(waypoints), 2)
    return {
        "mode": "foot",
        "provider": "fallback_straight_segments",
        "geometry": [[lat, lon] for lat, lon in waypoints],
        "distance_km": total_km,
        "duration_min": round((total_km / WALK_SPEED_KMH) * 60.0, 1),
        "fallback": True,
    }


# --- 2. КАТЕГОРИИ, BBOX И OVERPASS ---

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


def build_bbox(pt_a: dict, pt_b: dict, pad: float = 0.015) -> dict:
    """Строит прямоугольник (south, west, north, east) вокруг точек A и B с отступом pad."""
    south = min(pt_a["lat"], pt_b["lat"]) - pad
    north = max(pt_a["lat"], pt_b["lat"]) + pad
    west = min(pt_a["lon"], pt_b["lon"]) - pad
    east = max(pt_a["lon"], pt_b["lon"]) + pad
    return {
        "south": round(south, 6),
        "west": round(west, 6),
        "north": round(north, 6),
        "east": round(east, 6),
    }


def fetch_places_in_bbox(south: float, west: float, north: float, east: float) -> list[dict]:
    """Отправляет расширенный запрос в Overpass по прямоугольнику и возвращает список мест."""
    box = f"{south},{west},{north},{east}"

    overpass_query = f"""
    [out:json][timeout:60];

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

    response = requests.post(
        OVERPASS_URL,
        data={"data": overpass_query},
        headers=OVERPASS_HEADERS,
        timeout=65,
    )
    response.raise_for_status()

    elements = response.json().get("elements", [])
    places = []

    for el in elements:
        tags = el.get("tags", {})
        name = tags.get("name") or tags.get("name:ru") or tags.get("name:en")
        if not name:
            continue

        lat = el.get("lat") if "lat" in el else el.get("center", {}).get("lat")
        lon = el.get("lon") if "lon" in el else el.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue

        category = detect_place_category(tags)
        places.append({
            "id": el.get("id"),
            "name": name,
            "category": category,
            "category_label": CATEGORY_LABELS.get(category, category),
            "lat": float(lat),
            "lon": float(lon),
        })

    return places


# --- 3. РОУТЫ FLASK ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/points", methods=["GET"])
def get_points():
    return jsonify({
        "point_a": point_a,
        "point_b": point_b,
        "bbox": current_bbox,
        "places": found_places,
        "route_result": last_route_data,
    })


@app.route("/api/points", methods=["POST"])
def save_points():
    global point_a, point_b, current_bbox, found_places, last_route_data

    data = request.get_json(force=True)
    lat = data.get("lat")
    lon = data.get("lon")

    if lat is None or lon is None:
        return jsonify({"error": "Нужны координаты lat и lon"}), 400

    clicked = {"lat": float(lat), "lon": float(lon)}

    # 1-й клик -> A, 2-й клик -> B, 3-й клик -> сброс старой пары и новая точка A
    if point_a is None or (point_a is not None and point_b is not None):
        point_a = clicked
        point_b = None
    else:
        point_b = clicked

    current_bbox = None
    found_places = []
    last_route_data = None

    return jsonify({
        "point_a": point_a,
        "point_b": point_b,
    })


@app.route("/api/search-places", methods=["POST"])
def search_places():
    global current_bbox, found_places

    if point_a is None or point_b is None:
        return jsonify({"error": "Сначала поставьте на карте обе точки: A и B"}), 400

    data = request.get_json(silent=True) or {}
    pad = float(data.get("pad", 0.015))

    current_bbox = build_bbox(point_a, point_b, pad=pad)

    try:
        found_places = fetch_places_in_bbox(
            current_bbox["south"],
            current_bbox["west"],
            current_bbox["north"],
            current_bbox["east"],
        )
    except Exception as e:
        return jsonify({"error": f"Ошибка запроса к Overpass: {e}"}), 502

    return jsonify({
        "bbox": current_bbox,
        "count": len(found_places),
        "places": found_places,
    })


@app.route("/api/build-route", methods=["POST"])
def build_route():
    global current_bbox, found_places, last_route_data

    if point_a is None or point_b is None:
        return jsonify({"error": "Сначала поставьте на карте обе точки: A и B"}), 400

    data = request.get_json(silent=True) or {}
    pad = float(data.get("pad", 0.015))
    max_detour_km = float(data.get("max_detour_km", 0.8))
    max_stops = int(data.get("max_stops", 3))
    priority_categories = data.get("priority_categories") or []

    if not found_places:
        current_bbox = build_bbox(point_a, point_b, pad=pad)
        try:
            found_places = fetch_places_in_bbox(
                current_bbox["south"],
                current_bbox["west"],
                current_bbox["north"],
                current_bbox["east"],
            )
        except Exception as e:
            return jsonify({"error": f"Ошибка запроса к Overpass: {e}"}), 502

    stops = build_interesting_route_stops(
        point_a=(point_a["lat"], point_a["lon"]),
        point_b=(point_b["lat"], point_b["lon"]),
        places=found_places,
        priority_categories=priority_categories,
        max_stops=max_stops,
        max_detour_km=max_detour_km,
    )

    waypoints = (
        [(point_a["lat"], point_a["lon"])]
        + [(s["lat"], s["lon"]) for s in stops]
        + [(point_b["lat"], point_b["lon"])]
    )
    route_geom = build_walking_route_geometry(waypoints)

    last_route_data = {
        "stops": stops,
        "route": route_geom,
        "max_detour_km": max_detour_km,
        "max_stops": max_stops,
    }

    return jsonify(last_route_data)


if __name__ == "__main__":
    app.run(debug=True, port=5000)