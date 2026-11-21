import unittest
from unittest.mock import patch

import app


SARATOV_A = {"lat": 51.5336, "lon": 46.0343}
SARATOV_B = {"lat": 51.5400, "lon": 46.0500}


class LoopTestCase(unittest.TestCase):
    def setUp(self):
        app.app.config.update(TESTING=True)
        self.client = app.app.test_client()

        with app.state_lock:
            app.point_a = None
            app.point_b = None
            app.current_bbox = None
            app.found_places = []
            app.found_places_bbox_key = None
            app.found_places_source = None
            app.found_places_meta = {}
            app.last_route_data = None

        app._places_cache.clear()
        with app._overpass_guard_lock:
            app._overpass_failed_until.clear()

    def test_local_geojson_is_loaded_and_has_coverage(self):
        places = app._get_saratov_places_from_geojson()
        coverage = app.get_local_coverage()

        self.assertGreater(len(places), 500)
        self.assertIsNotNone(coverage)
        self.assertLess(coverage["south"], coverage["north"])
        self.assertLess(coverage["west"], coverage["east"])

    def test_route_stop_selection_and_detour_limit(self):
        near = {
            "name": "Точка на пути",
            "lat": 51.5368,
            "lon": 46.0422,
            "category": "nature",
        }
        far = {
            "name": "Слишком далеко",
            "lat": 51.62,
            "lon": 46.20,
            "category": "nature",
        }

        stops = app.build_interesting_route_stops(
            (SARATOV_A["lat"], SARATOV_A["lon"]),
            (SARATOV_B["lat"], SARATOV_B["lon"]),
            [near, far],
            max_stops=3,
            max_detour_km=1.5,
        )

        self.assertEqual([s["name"] for s in stops], ["Точка на пути"])

    def test_places_are_not_mixed_when_overpass_recovers(self):
        live_element = {
            "type": "node",
            "id": 1,
            "lat": 51.5368,
            "lon": 46.0422,
            "tags": {"name": "Живое место", "tourism": "museum"},
        }
        with patch.object(
            app,
            "_overpass_request",
            return_value=([live_element], "https://overpass-api.de/api/interpreter"),
        ):
            places, source, _meta = app.fetch_places_in_bbox(
                51.52, 46.02, 51.56, 46.06, force=True
            )

        self.assertEqual(source, "overpass-turbo")
        self.assertEqual([p["name"] for p in places], ["Живое место"])
        self.assertFalse(any(p["name"] == "Парк Победы" for p in places))

    def test_search_falls_back_to_local_geojson(self):
        with patch.object(app, "_overpass_request", side_effect=RuntimeError("down")):
            response = self.client.post(
                "/api/search-places",
                json={
                    "point_a": SARATOV_A,
                    "point_b": SARATOV_B,
                    "pad": 0.02,
                    "categories": ["nature", "historic"],
                },
            )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["source"], "local_saratov_geojson")
        self.assertTrue(data["fallback"])
        self.assertIsNotNone(data["notice"])
        self.assertGreater(len(data["all_places"]), 0)
        self.assertTrue(all(p["category"] in {"nature", "historic"} for p in data["places"]))

    def test_empty_category_list_returns_no_places(self):
        with patch.object(app, "_overpass_request", side_effect=RuntimeError("down")):
            response = self.client.post(
                "/api/search-places",
                json={
                    "point_a": SARATOV_A,
                    "point_b": SARATOV_B,
                    "pad": 0.02,
                    "categories": [],
                },
            )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["count"], 0)
        self.assertEqual(data["places"], [])
        self.assertGreater(len(data["all_places"]), 0)

    def test_route_is_built_from_explicit_request_points(self):
        fallback_route = {
            "mode": "foot",
            "provider": "test",
            "geometry": [
                [SARATOV_A["lat"], SARATOV_A["lon"]],
                [SARATOV_B["lat"], SARATOV_B["lon"]],
            ],
            "distance_km": 1.5,
            "duration_min": 20.0,
            "fallback": False,
        }
        with patch.object(app, "_overpass_request", side_effect=RuntimeError("down")), patch.object(
            app, "build_walking_route_geometry", return_value=fallback_route
        ):
            response = self.client.post(
                "/api/build-route",
                json={
                    "point_a": SARATOV_A,
                    "point_b": SARATOV_B,
                    "pad": 0.02,
                    "max_stops": 3,
                    "max_detour_km": 1.5,
                    "categories": ["nature", "historic"],
                },
            )

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["source"], "local_saratov_geojson")
        self.assertEqual(data["route"]["provider"], "test")
        self.assertLessEqual(len(data["stops"]), 3)

    def test_invalid_coordinates_and_nan_are_rejected(self):
        cases = [
            ({"lat": "abc", "lon": 46.0}, 400),
            ({"lat": 200, "lon": 46.0}, 400),
            ({"lat": 51.0, "lon": 999}, 400),
        ]
        for payload, status in cases:
            response = self.client.post("/api/points", json=payload)
            self.assertEqual(response.status_code, status, payload)
            self.assertIn("error", response.get_json())

        response = self.client.post(
            "/api/search-places",
            json={"point_a": SARATOV_A, "point_b": SARATOV_B, "pad": "nan"},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("pad", response.get_json()["error"])

    def test_oversized_bbox_is_rejected(self):
        response = self.client.post(
            "/api/search-places",
            json={
                "point_a": {"lat": 51.53, "lon": 46.03},
                "point_b": {"lat": 55.75, "lon": 37.61},
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("большая область", response.get_json()["error"])

    def test_cross_site_post_is_rejected(self):
        response = self.client.post(
            "/api/points",
            headers={"Origin": "https://evil.example"},
            json={"lat": 51.53, "lon": 46.03},
        )
        self.assertEqual(response.status_code, 403)

    def test_index_uses_osm_tiles(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)

        script = self.client.get("/static/js/app.js")
        self.assertEqual(script.status_code, 200)
        self.assertIn(b"tile.openstreetmap.org", script.data)
        self.assertNotIn(b"cartocdn", script.data)

    def test_place_image_endpoint(self):
        fake_image = {
            "url": "https://upload.wikimedia.org/wikipedia/commons/thumb/test.jpg",
            "page_url": "https://commons.wikimedia.org/wiki/File:test.jpg",
            "title": "test.jpg",
            "source": "Wikimedia Commons",
            "artist": "Test Author",
            "license": "CC BY-SA 4.0",
        }
        with patch.object(app, "get_place_image", return_value=fake_image) as mocked:
            response = self.client.get(
                "/api/place-image?name=Музей&lat=51.5336&lon=46.0343"
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["image"], fake_image)
        mocked.assert_called_once()
        args = mocked.call_args.args
        self.assertEqual(args[0], "Музей")
        self.assertAlmostEqual(args[1], 51.5336)
        self.assertAlmostEqual(args[2], 46.0343)

    def test_clubs_are_filtered_from_places(self):
        club = app._place_from_tags(
            {"name": "Подростковый клуб «Юность»", "amenity": "community_centre"},
            51.53,
            46.03,
        )
        nightclub = app._place_from_tags(
            {"name": "Ночной клуб", "amenity": "nightclub"},
            51.53,
            46.03,
        )
        museum = app._place_from_tags(
            {
                "name": "Художественный музей",
                "tourism": "museum",
                "contact:vk": "https://vk.com/club123",
            },
            51.53,
            46.03,
        )

        self.assertIsNone(club)
        self.assertIsNone(nightclub)
        self.assertIsNotNone(museum)

    def test_local_geojson_no_longer_contains_clubs(self):
        import json
        from pathlib import Path

        raw = json.loads(Path(app.SARATOV_GEOJSON_FILE).read_text(encoding="utf-8"))
        for feature in raw.get("features", []):
            props = feature.get("properties") or {}
            tags = props.get("tags") if isinstance(props.get("tags"), dict) else props
            name = tags.get("name") or tags.get("name:ru") or tags.get("name:en") or ""
            self.assertFalse(app._looks_like_club(tags, name), name)

    def test_osrm_steps_are_parsed_for_navigation(self):
        route = {
            "legs": [
                {
                    "steps": [
                        {
                            "maneuver": {"type": "depart", "modifier": "left", "location": [46.0, 51.0]},
                            "name": "улица A",
                            "distance": 100,
                            "duration": 80,
                        },
                        {
                            "maneuver": {"type": "turn", "modifier": "right", "location": [46.01, 51.01]},
                            "name": "улица B",
                            "distance": 50,
                            "duration": 40,
                        },
                        {
                            "maneuver": {"type": "arrive", "location": [46.02, 51.02]},
                            "distance": 0,
                            "duration": 0,
                        },
                    ]
                },
                {
                    "steps": [
                        {
                            "maneuver": {"type": "depart", "modifier": "left", "location": [46.02, 51.02]},
                            "distance": 80,
                            "duration": 60,
                        },
                        {
                            "maneuver": {"type": "turn", "modifier": "left", "location": [46.03, 51.03]},
                            "distance": 20,
                            "duration": 15,
                        },
                        {
                            "maneuver": {"type": "arrive", "location": [46.04, 51.04]},
                            "distance": 0,
                            "duration": 0,
                        },
                    ]
                },
            ]
        }

        steps = app._parse_route_steps(route)

        self.assertEqual(len(steps), 5)
        self.assertEqual(steps[0]["type"], "depart")
        self.assertEqual(steps[1]["type"], "turn")
        self.assertEqual(steps[2]["type"], "continue")
        self.assertEqual(steps[2]["location"], [51.02, 46.02])
        self.assertEqual(steps[-1]["type"], "arrive")
        self.assertEqual(
            [s["type"] for s in steps].count("arrive"),
            1,
        )

    def test_place_image_urls_are_restricted_to_wikimedia(self):
        self.assertTrue(
            app._is_safe_https_url(
                "https://upload.wikimedia.org/wikipedia/commons/test.jpg",
                app._IMAGE_HOSTS,
            )
        )
        self.assertTrue(
            app._is_safe_https_url(
                "https://thumb.wikimedia.org/wikipedia/commons/thumb/test.jpg",
                app._IMAGE_HOSTS,
            )
        )
        self.assertFalse(
            app._is_safe_https_url(
                "http://upload.wikimedia.org/wikipedia/commons/test.jpg",
                app._IMAGE_HOSTS,
            )
        )
        self.assertFalse(
            app._is_safe_https_url(
                "https://evil.example/test.jpg",
                app._IMAGE_HOSTS,
            )
        )


if __name__ == "__main__":
    unittest.main()
