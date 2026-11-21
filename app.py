# aboba!!!!!!!
# asus vivobook
import requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Храним две точки, границы прямоугольника и найденные места в переменных на сервере
point_a = None
point_b = None
current_bbox = None
found_places = []

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


def build_bbox(pt_a: dict, pt_b: dict, pad: float = 0.02) -> dict:
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


def fetch_places_in_bbox(
    south: float, west: float, north: float, east: float
) -> list[dict]:
    """Отправляет запрос в Overpass по прямоугольнику и возвращает список мест с координатами."""
    box = f"{south},{west},{north},{east}"

    overpass_query = f"""
    [out:json][timeout:60];

    (
      nwr["tourism"="artwork"]({box});
      nwr["artwork_type"]({box});
      nwr["tourism"~"attraction|museum|viewpoint|gallery"]({box});
      nwr["historic"]({box});
      nwr["leisure"~"park|garden"]({box});
      nwr["amenity"~"fountain|theatre|arts_centre|library|planetarium|clock"]({box});
      nwr["amenity"="place_of_worship"]({box});
      nwr["building"~"church|cathedral|mosque|synagogue|chapel"]({box});
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

        # У node координаты в el["lat"], el["lon"], а у way/relation — в el["center"]
        lat = el.get("lat") if "lat" in el else el.get("center", {}).get("lat")
        lon = el.get("lon") if "lon" in el else el.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue

        places.append(
            {
                "id": el.get("id"),
                "name": name,
                "lat": float(lat),
                "lon": float(lon),
            }
        )

    return places


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/points", methods=["GET"])
def get_points():
    return jsonify(
        {
            "point_a": point_a,
            "point_b": point_b,
            "bbox": current_bbox,
            "places": found_places,
        }
    )


@app.route("/api/points", methods=["POST"])
def save_points():
    global point_a, point_b

    data = request.get_json(force=True)
    lat = data.get("lat")
    lon = data.get("lon")

    if lat is None or lon is None:
        return jsonify({"error": "Нужны координаты lat и lon"}), 400

    clicked = {"lat": float(lat), "lon": float(lon)}

    # 1-й клик -> A, 2-й клик -> B, 3-й клик -> сброс и новая A
    if point_a is None or (point_a is not None and point_b is not None):
        point_a = clicked
        point_b = None
    else:
        point_b = clicked

    return jsonify(
        {
            "point_a": point_a,
            "point_b": point_b,
        }
    )


@app.route("/api/search-places", methods=["POST"])
def search_places():
    global current_bbox, found_places

    if point_a is None or point_b is None:
        return jsonify({"error": "Сначала поставьте на карте обе точки: A и B"}), 400

    data = request.get_json(silent=True) or {}
    pad = float(data.get("pad", 0.02))

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

    return jsonify(
        {
            "bbox": current_bbox,
            "count": len(found_places),
            "places": found_places,
        }
    )


if __name__ == "__main__":
    app.run(debug=True, port=5000)
