(function () {
  "use strict";

  const LS_KEY = "loop:settings:v2";
  const DEFAULT_VIEW = { lat: 51.533562, lng: 46.034266, zoom: 13 };
  const MOBILE_QUERY = "(max-width: 900px)";

  const CATEGORY_META = {
    tourism_view: { label: "Достопримечательности", color: "#0ea5e9" },
    historic: { label: "История", color: "#ef4444" },
    nature: { label: "Парки", color: "#22c55e" },
    culture: { label: "Музеи", color: "#f59e0b" },
    art: { label: "Искусство", color: "#a855f7" },
    urban: { label: "Архитектура", color: "#6366f1" },
    worship: { label: "Храмы", color: "#d97706" },
  };

  // Исходный порядок важен: он превращается в приоритет категорий на сервере.
  // Порядок чипов в интерфейсе может быть любым.
  const CATEGORY_PRIORITY = [
    "tourism_view",
    "art",
    "culture",
    "historic",
    "nature",
    "urban",
    "worship",
  ];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const mapEl = $("#map");
  const sheet = $("#sheet");
  const sheetHandle = $("#sheetHandle");
  const sheetBody = $("#sheetBody");
  const peek = $("#peek");
  const peekTitle = $("#peekTitle");
  const peekSub = $("#peekSub");

  const pointARow = $("#pointARow");
  const pointBRow = $("#pointBRow");
  const pointAValue = $("#pointAValue");
  const pointBValue = $("#pointBValue");
  const swapBtn = $("#swapBtn");
  const resetBtn = $("#resetBtn");

  const categoriesEl = $("#categories");
  const catsAll = $("#catsAll");
  const catsNone = $("#catsNone");

  const padSlider = $("#padSlider");
  const padInput = $("#padInput");
  const detourSlider = $("#detourSlider");
  const detourInput = $("#detourInput");
  const stopsSlider = $("#stopsSlider");
  const stopsInput = $("#stopsInput");

  const searchBtn = $("#searchBtn");
  const routeBtn = $("#routeBtn");
  const retryLive = $("#retryLive");

  const notice = $("#notice");
  const noticeText = $("#noticeText");

  const resultCard = $("#resultCard");
  const resultBadge = $("#resultBadge");
  const metricDistance = $("#metricDistance");
  const metricDuration = $("#metricDuration");
  const metricStops = $("#metricStops");
  const stopsList = $("#stopsList");
  const resultNote = $("#resultNote");

  const mapHint = $("#mapHint");
  const mapHintText = $("#mapHintText");
  const locateBtn = $("#locateBtn");
  const locateCardBtn = $("#locateCardBtn");
  const geoHint = $("#geoHint");
  const themeBtn = $("#themeBtn");
  const toast = $("#toast");

  const mobileMedia = window.matchMedia(MOBILE_QUERY);

  const state = {
    pointA: null,
    pointB: null,
    allPlaces: [],
    filteredPlaces: [],
    searched: false,
    bbox: null,
    source: null,
    provider: null,
    providerError: null,
    routeData: null,
    busy: null,
  };

  let currentTheme = "light";
  let saveTimer = null;
  let toastTimer = null;
  let resizeTimer = null;
  let syncController = null;
  let stopMarkers = [];
  let markerA = null;
  let markerB = null;
  let previewRect = null;
  let tileLayer = null;
  let tileErrors = 0;
  let tileErrorShown = false;
  let locationLayer = null;

  const sliderControls = [
    {
      slider: padSlider,
      input: padInput,
      decimals: 3,
      onInput: () => drawPreview(false),
    },
    {
      slider: detourSlider,
      input: detourInput,
      decimals: 1,
      onInput: null,
    },
    {
      slider: stopsSlider,
      input: stopsInput,
      decimals: 0,
      onInput: null,
    },
  ];

  // ------------------------------------------------------------
  // Карта
  // ------------------------------------------------------------

  const map = L.map(mapEl, {
    zoomControl: false,
    attributionControl: false,
    preferCanvas: true,
    minZoom: 2,
    maxZoom: 19,
    worldCopyJump: true,
  });

  map.createPane("previewPane").style.zIndex = "405";
  map.createPane("routePane").style.zIndex = "410";
  map.createPane("placePane").style.zIndex = "420";
  map.createPane("stopPane").style.zIndex = "450";

  L.control.zoom({ position: "topright" }).addTo(map);
  L.control.attribution({ position: "bottomleft", prefix: false }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false, maxWidth: 100 }).addTo(map);

  const placeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);

  // Подложка карты — всегда OpenStreetMap. В тёмной теме тайлы
  // приглушаются CSS-фильтром, но источник остаётся тем же.
  const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  function handleTileError() {
    tileErrors += 1;
    if (tileErrorShown || tileErrors < 12) return;
    tileErrorShown = true;
    showToast("Не удалось загрузить тайлы OpenStreetMap. Проверьте интернет.", "error");
  }

  function setTiles() {
    if (tileLayer) {
      map.removeLayer(tileLayer);
      tileLayer = null;
    }
    tileErrors = 0;
    tileErrorShown = false;

    tileLayer = L.tileLayer(OSM_TILE_URL, {
      maxZoom: 19,
      attribution: OSM_ATTRIBUTION,
    });
    tileLayer.on("tileerror", handleTileError);
    tileLayer.addTo(map);
  }

  function applyTheme(theme, options = {}) {
    currentTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = currentTheme;
    const themeMeta = $('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", currentTheme === "dark" ? "#080f1c" : "#f4f6f9");
    if (!tileLayer) setTiles();
    if (state.routeData) renderRoute(state.routeData, { fit: false });
    if (state.pointA && state.pointB) drawPreview(false);
    if (options.persist !== false) saveSoon();
  }

  // ------------------------------------------------------------
  // Утилиты
  // ------------------------------------------------------------

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      if (ch === '"') return "&quot;";
      return "&#39;";
    });
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function roundCoord(value) {
    return Number(Number(value).toFixed(7));
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback || "";
  }

  function plural(count, forms) {
    const n = Math.abs(count) % 100;
    const last = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
  }

  function fmtKm(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n >= 10) return `${Math.round(n)} км`;
    const rounded = Math.round(n * 10) / 10;
    return `${rounded.toFixed(1).replace(".0", "")} км`;
  }

  function fmtMin(value) {
    const total = Math.round(Number(value));
    if (!Number.isFinite(total) || total < 0) return "—";
    if (total < 60) return `${total} мин`;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }

  function formatPoint(point) {
    if (!point) return "";
    return `${Number(point.lat).toFixed(5)}, ${Number(point.lon).toFixed(5)}`;
  }

  function validPoint(point) {
    return (
      point &&
      typeof point === "object" &&
      isFiniteNumber(Number(point.lat)) &&
      isFiniteNumber(Number(point.lon)) &&
      Math.abs(Number(point.lat)) <= 90 &&
      Math.abs(Number(point.lon)) <= 180
    );
  }

  function normalizePoint(point) {
    return { lat: roundCoord(point.lat), lon: roundCoord(point.lon) };
  }

  function isMobile() {
    return mobileMedia.matches;
  }

  function sourceLabel(source) {
    if (!source) return "—";
    return source === "overpass-turbo" ? "Overpass" : "Локальные данные";
  }

  function selectedCategories() {
    const checked = new Set($$(".cat-cb:checked").map((checkbox) => checkbox.value));
    return CATEGORY_PRIORITY.filter((category) => checked.has(category));
  }

  function bboxToBounds(bbox) {
    if (!bbox) return null;
    const bounds = L.latLngBounds([bbox.south, bbox.west], [bbox.north, bbox.east]);
    return bounds.isValid() ? bounds : null;
  }

  function fitMapTo(target, options = {}) {
    let bounds = null;
    if (target instanceof L.LatLngBounds) {
      bounds = target;
    } else if (target && typeof target.south === "number" && typeof target.north === "number") {
      bounds = bboxToBounds(target);
    } else if (Array.isArray(target)) {
      bounds = L.latLngBounds(target);
    }
    if (!bounds || !bounds.isValid()) return;

    const mobile = isMobile();
    map.fitBounds(bounds, {
      paddingTopLeft: [mobile ? 24 : 28, mobile ? 74 : 28],
      paddingBottomRight: [mobile ? 24 : 28, mobile ? 160 : 28],
      maxZoom: options.maxZoom || 17,
    });
  }

  // ------------------------------------------------------------
  // Тосты и уведомления
  // ------------------------------------------------------------

  function showToast(message, type) {
    if (!toast || !message) return;
    toast.textContent = message;
    toast.dataset.type = type || "info";
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, type === "error" ? 5500 : 4000);
  }

  function showNotice(text, options = {}) {
    if (!text) {
      hideNotice();
      return;
    }
    notice.hidden = false;
    notice.dataset.type = options.type || "warn";
    noticeText.textContent = text;
    retryLive.hidden = !options.retry;
  }

  function hideNotice() {
    notice.hidden = true;
    noticeText.textContent = "";
    retryLive.hidden = true;
  }

  function updateSourcePill() {
    $$("[data-source-pill]").forEach((pill) => {
      if (!state.source) {
        pill.hidden = true;
        return;
      }
      pill.hidden = false;
      pill.dataset.kind = state.source === "overpass-turbo" ? "live" : "local";
      const label = pill.querySelector("[data-source-text]");
      if (label) label.textContent = sourceLabel(state.source);
      let title = state.provider ? `Источник: ${state.provider}` : "";
      if (state.providerError) title += `\n${String(state.providerError).slice(0, 300)}`;
      pill.title = title;
    });
  }

  // ------------------------------------------------------------
  // Настройки и сохранение
  // ------------------------------------------------------------

  function readSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_error) {
      return {};
    }
  }

  function saveNow() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          pointA: state.pointA,
          pointB: state.pointB,
          categories: selectedCategories(),
          pad: Number(padSlider.value),
          detour: Number(detourSlider.value),
          stops: Number(stopsSlider.value),
          theme: currentTheme,
          view: {
            lat: map.getCenter().lat,
            lng: map.getCenter().lng,
            zoom: map.getZoom(),
          },
        })
      );
    } catch (_error) {
      /* localStorage может быть недоступен в приватном режиме */
    }
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function restoreSettings() {
    const saved = readSettings();

    if (validPoint(saved.pointA)) state.pointA = normalizePoint(saved.pointA);
    if (validPoint(saved.pointB)) state.pointB = normalizePoint(saved.pointB);

    if (Array.isArray(saved.categories)) {
      const allowed = new Set(saved.categories.filter((cat) => CATEGORY_META[cat]));
      $$(".cat-cb").forEach((checkbox) => {
        checkbox.checked = allowed.has(checkbox.value);
      });
    }

    padSlider.value = String(clampNumber(saved.pad, 0.001, 0.05, 0.02));
    detourSlider.value = String(clampNumber(saved.detour, 0.2, 5, 1.5));
    stopsSlider.value = String(Math.round(clampNumber(saved.stops, 1, 100, 3)));

    const view = saved.view;
    if (
      view &&
      isFiniteNumber(Number(view.lat)) &&
      isFiniteNumber(Number(view.lng)) &&
      isFiniteNumber(Number(view.zoom))
    ) {
      map.setView(
        [clampNumber(view.lat, -90, 90, DEFAULT_VIEW.lat), clampNumber(view.lng, -180, 180, DEFAULT_VIEW.lng)],
        clampNumber(view.zoom, 2, 19, DEFAULT_VIEW.zoom)
      );
    } else {
      map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], DEFAULT_VIEW.zoom);
    }

    if (saved.theme === "dark" || saved.theme === "light") {
      currentTheme = saved.theme;
    } else {
      currentTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  }

  function formatControlValue(value, decimals) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
  }

  function updateSliderTrack(control) {
    const min = Number(control.slider.min);
    const max = Number(control.slider.max);
    const value = Number(control.slider.value);
    const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
    control.slider.style.setProperty("--p", `${percent}%`);
  }

  function setupSliderControl(control) {
    const { slider, input, decimals } = control;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const step = Number(slider.step) || 1;

    const apply = () => {
      updateSliderTrack(control);
      if (control.onInput) control.onInput();
      updatePeek();
    };

    const commit = () => {
      let value = Number(String(input.value).replace(",", "."));
      if (!Number.isFinite(value)) value = Number(slider.value);
      value = Math.min(max, Math.max(min, value));
      const snapped = min + Math.round((value - min) / step) * step;
      value = Number(Math.min(max, Math.max(min, snapped)).toFixed(decimals));

      slider.value = String(value);
      input.value = formatControlValue(value, decimals);
      input.removeAttribute("aria-invalid");
      apply();
      saveNow();
    };

    control.commit = commit;

    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      input.value = formatControlValue(value, decimals);
      input.removeAttribute("aria-invalid");
      apply();
    });
    slider.addEventListener("change", saveNow);

    input.addEventListener("input", () => {
      const value = Number(String(input.value).replace(",", "."));
      if (!Number.isFinite(value) || value < min || value > max) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      input.removeAttribute("aria-invalid");
      slider.value = String(value);
      apply();
    });

    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
        return;
      }

      // Управление стрелками с клавиатуры — независимо от поведения браузера.
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? step : -step;
        let value = Number(String(input.value).replace(",", "."));
        if (!Number.isFinite(value)) value = Number(slider.value);
        value = Math.min(max, Math.max(min, value + delta));
        value = Number(value.toFixed(decimals));

        slider.value = String(value);
        input.value = formatControlValue(value, decimals);
        input.removeAttribute("aria-invalid");
        apply();
        saveSoon();
      }
    });

    input.value = formatControlValue(Number(slider.value), decimals);
    updateSliderTrack(control);
  }

  function commitNumberInputs() {
    sliderControls.forEach((control) => {
      if (control.commit) control.commit();
    });
  }

  // ------------------------------------------------------------
  // Отображение точек и результатов
  // ------------------------------------------------------------

  function pointIcon(letter) {
    return L.divIcon({
      className: `point-marker ${letter.toLowerCase()}`,
      html: `<span>${letter}</span>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -18],
    });
  }

  function renderPoints() {
    if (markerA) {
      map.removeLayer(markerA);
      markerA = null;
    }
    if (markerB) {
      map.removeLayer(markerB);
      markerB = null;
    }

    if (state.pointA) {
      markerA = L.marker([state.pointA.lat, state.pointA.lon], {
        icon: pointIcon("A"),
        title: "Точка A",
        riseOnHover: true,
        bubblingMouseEvents: false,
      }).addTo(map);
      markerA.bindPopup("Точка A");
    }

    if (state.pointB) {
      markerB = L.marker([state.pointB.lat, state.pointB.lon], {
        icon: pointIcon("B"),
        title: "Точка B",
        riseOnHover: true,
        bubblingMouseEvents: false,
      }).addTo(map);
      markerB.bindPopup("Точка B");
    }
  }

  function previewBbox() {
    if (!state.pointA || !state.pointB) return null;
    const pad = Number(padSlider.value);
    return {
      south: Math.min(state.pointA.lat, state.pointB.lat) - pad,
      west: Math.min(state.pointA.lon, state.pointB.lon) - pad,
      north: Math.max(state.pointA.lat, state.pointB.lat) + pad,
      east: Math.max(state.pointA.lon, state.pointB.lon) + pad,
    };
  }

  function drawPreview(fit, bboxOverride) {
    if (previewRect) {
      map.removeLayer(previewRect);
      previewRect = null;
    }

    const bbox = bboxOverride || previewBbox();
    if (!bbox) return;

    const color = cssVar("--accent", "#2563eb");
    previewRect = L.rectangle(
      [
        [bbox.south, bbox.west],
        [bbox.north, bbox.east],
      ],
      {
        pane: "previewPane",
        color,
        weight: 1.5,
        opacity: 0.75,
        dashArray: "6 7",
        fillColor: color,
        fillOpacity: 0.035,
        interactive: false,
        bubblingMouseEvents: false,
      }
    ).addTo(map);

    if (fit) fitMapTo(bbox, { maxZoom: 16 });
  }

  function renderPlaces(places) {
    placeLayer.clearLayers();

    (places || []).forEach((place) => {
      if (!place || !isFiniteNumber(Number(place.lat)) || !isFiniteNumber(Number(place.lon))) return;
      const meta = CATEGORY_META[place.category] || CATEGORY_META.tourism_view;
      const cat = CATEGORY_META[place.category] ? place.category : "tourism_view";

      const marker = L.circleMarker([Number(place.lat), Number(place.lon)], {
        pane: "placePane",
        radius: 5.5,
        color: "#ffffff",
        weight: 1.5,
        opacity: 1,
        fillColor: meta.color,
        fillOpacity: 0.95,
        bubblingMouseEvents: false,
      });

      marker.bindTooltip(esc(place.name || "Место"), {
        direction: "top",
        offset: [0, -3],
        opacity: 0.95,
      });
      marker.bindPopup(
        `<div class="popup">` +
          `<div class="popup-cat" data-cat="${esc(cat)}"><span class="popup-dot"></span>` +
          `${esc(place.category_label || meta.label)}</div>` +
          `<b>${esc(place.name || "Место")}</b>` +
          `</div>`
      );
      marker.addTo(placeLayer);
    });
  }

  function clearRouteVisual() {
    routeLayer.clearLayers();
    stopMarkers = [];
  }

  function clearResultUI() {
    resultCard.hidden = true;
    stopsList.innerHTML = "";
    resultBadge.textContent = "";
    resultBadge.className = "result-badge";
    metricDistance.textContent = "—";
    metricDuration.textContent = "—";
    metricStops.textContent = "—";
    resultNote.hidden = true;
    resultNote.textContent = "";
  }

  function stopPopup(stop, index) {
    const cat = CATEGORY_META[stop.category] ? stop.category : "tourism_view";
    return (
      `<div class="popup">` +
      `<div class="popup-cat" data-cat="${esc(cat)}"><span class="popup-dot"></span>` +
      `Остановка ${index + 1}${stop.category_label ? ` · ${esc(stop.category_label)}` : ""}</div>` +
      `<b>${esc(stop.name || "Место")}</b>` +
      `</div>`
    );
  }

  function renderRoute(data, options = {}) {
    clearRouteVisual();

    const route = data && data.route ? data.route : null;
    const coords = route && Array.isArray(route.geometry) ? route.geometry : [];

    if (coords.length >= 2) {
      const color = cssVar("--route", "#2563eb");
      const casingColor = currentTheme === "dark" ? "#08101f" : "#ffffff";
      const casing = {
        pane: "routePane",
        color: casingColor,
        weight: 10,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      };
      const line = {
        pane: "routePane",
        color,
        weight: 5,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false,
      };
      if (route.fallback) {
        casing.dashArray = "8 8";
        line.dashArray = "8 8";
      }
      L.polyline(coords, casing).addTo(routeLayer);
      L.polyline(coords, line).addTo(routeLayer);
      if (options.fit !== false) fitMapTo(coords, { maxZoom: 17 });
    }

    const stops = data && Array.isArray(data.stops) ? data.stops : [];
    stops.forEach((stop, index) => {
      if (!stop || !isFiniteNumber(Number(stop.lat)) || !isFiniteNumber(Number(stop.lon))) return;
      const icon = L.divIcon({
        className: "stop-marker",
        html: `<span>${index + 1}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        popupAnchor: [0, -15],
      });
      const marker = L.marker([Number(stop.lat), Number(stop.lon)], {
        icon,
        pane: "stopPane",
        riseOnHover: true,
        zIndexOffset: 200,
        bubblingMouseEvents: false,
      }).addTo(routeLayer);
      marker.bindPopup(stopPopup(stop, index));
      stopMarkers[index] = marker;
    });

    updateResultUI(data);
  }

  function updateResultUI(data) {
    const route = data && data.route ? data.route : null;
    const stops = data && Array.isArray(data.stops) ? data.stops : [];
    const local = (data && data.source ? data.source : state.source) === "local_saratov_geojson";

    resultCard.hidden = false;
    metricDistance.textContent = fmtKm(route ? route.distance_km : null);
    metricDuration.textContent = fmtMin(route ? route.duration_min : null);
    metricStops.textContent = String(stops.length);

    resultBadge.textContent = local ? "Локальные данные" : "Overpass";
    resultBadge.className = `result-badge ${local ? "local" : "live"}`;

    if (stops.length) {
      stopsList.innerHTML = stops
        .map((stop, index) => {
          const name = esc(stop.name || "Без названия");
          const meta = esc(stop.category_label || "");
          return (
            `<button class="stop" type="button" data-stop="${index}" ` +
            `aria-label="Показать остановку ${index + 1}: ${name}">` +
            `<span class="stop-num" aria-hidden="true">${index + 1}</span>` +
            `<span class="stop-info"><span class="stop-name">${name}</span>` +
            `<span class="stop-meta">${meta}</span></span>` +
            `<span class="stop-go" aria-hidden="true">` +
            `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
            `stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>` +
            `</span></button>`
          );
        })
        .join("");
    } else {
      stopsList.innerHTML =
        '<div class="empty">По пути не нашлось мест. Увеличьте «крюк» или выберите больше категорий.</div>';
    }

    const notes = [];
    if (route && route.fallback) {
      notes.push("Маршрутизатор недоступен — линия показана прямыми отрезками.");
    }
    if (!stops.length) notes.push("Попробуйте увеличить максимальный крюк.");
    resultNote.hidden = notes.length === 0;
    resultNote.textContent = notes.join(" ");
  }

  function updateCounts() {
    const counts = {};
    if (state.searched) {
      state.allPlaces.forEach((place) => {
        if (!place || !place.category) return;
        counts[place.category] = (counts[place.category] || 0) + 1;
      });
    }

    $$(".chip-count").forEach((badge) => {
      const count = state.searched ? counts[badge.dataset.count] || 0 : 0;
      badge.textContent = count ? String(count) : "";
      badge.hidden = count === 0;
    });
  }

  function updatePeek() {
    if (state.routeData) {
      const route = state.routeData.route || {};
      const stops = Array.isArray(state.routeData.stops) ? state.routeData.stops.length : 0;
      peekTitle.textContent = `${fmtKm(route.distance_km)} · ${fmtMin(route.duration_min)}`;
      peekSub.textContent =
        `${stops} ${plural(stops, ["остановка", "остановки", "остановок"])} · ` +
        sourceLabel(state.routeData.source || state.source);
      return;
    }

    if (state.searched) {
      const count = state.filteredPlaces.length;
      peekTitle.textContent = `Найдено ${count} ${plural(count, ["место", "места", "мест"])}`;
      peekSub.textContent = `${sourceLabel(state.source)} · выберите настройки и постройте маршрут`;
      return;
    }

    if (!state.pointA) {
      peekTitle.textContent = "Маршрут по местам";
      peekSub.textContent = "Тапните по карте — точка A";
      return;
    }

    if (!state.pointB) {
      peekTitle.textContent = "Точка A поставлена";
      peekSub.textContent = "Тапните по карте — точка B";
      return;
    }

    peekTitle.textContent = "Точки A и B готовы";
    peekSub.textContent = "Откройте настройки и постройте маршрут";
  }

  function updatePointsUI() {
    pointAValue.textContent = state.pointA ? formatPoint(state.pointA) : "Кликните по карте";
    pointBValue.textContent = state.pointB ? formatPoint(state.pointB) : "Кликните по карте";
    pointARow.classList.toggle("filled", Boolean(state.pointA));
    pointBRow.classList.toggle("filled", Boolean(state.pointB));

    swapBtn.disabled = Boolean(state.busy) || !(state.pointA && state.pointB);
    resetBtn.disabled = Boolean(state.busy);

    if (!state.pointA) {
      mapHintText.textContent = "Кликните по карте — точка A";
    } else if (!state.pointB) {
      mapHintText.textContent = "Кликните по карте — точка B";
    } else {
      mapHintText.textContent = "Клик — новый маршрут";
    }
    mapHint.classList.toggle("hidden", Boolean(state.pointA && state.pointB));
  }

  function refreshFilter(options = {}) {
    const allowed = new Set(selectedCategories());
    state.filteredPlaces = state.searched
      ? state.allPlaces.filter((place) => place && allowed.has(place.category))
      : [];
    renderPlaces(state.filteredPlaces);
    updateCounts();

    if (options.clearRoute) {
      clearRouteVisual();
      clearResultUI();
      state.routeData = null;
    }
    updatePeek();
  }

  function clearDerivedForPoints() {
    state.allPlaces = [];
    state.filteredPlaces = [];
    state.searched = false;
    state.bbox = null;
    state.routeData = null;
    state.source = null;
    state.provider = null;
    state.providerError = null;

    placeLayer.clearLayers();
    clearRouteVisual();
    clearResultUI();
    hideNotice();
    updateSourcePill();
    updateCounts();
  }

  // ------------------------------------------------------------
  // API
  // ------------------------------------------------------------

  async function apiPost(url, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 45000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: controller.signal,
      });

      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_error) {
          throw new Error("Сервер вернул некорректный ответ.");
        }
      }

      if (!response.ok) {
        throw new Error(data.error || `Ошибка сервера (${response.status}).`);
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Сервер отвечает слишком долго. Попробуйте ещё раз.");
      }
      if (error instanceof TypeError) {
        throw new Error("Не удалось связаться с сервером.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function syncPoints(payload) {
    try {
      if (syncController) syncController.abort();
    } catch (_error) {
      /* ignore */
    }
    syncController = new AbortController();

    fetch("/api/points", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      keepalive: true,
      signal: syncController.signal,
    }).catch(() => {
      /* не блокируем интерфейс, если сервер недоступен */
    });
  }

  function ensurePoints() {
    if (state.pointA && state.pointB) return true;
    showToast(
      !state.pointA
        ? "Сначала поставьте точку A: кликните по карте."
        : "Теперь поставьте точку B: кликните по карте.",
      "info"
    );
    updatePointsUI();
    updatePeek();
    return false;
  }

  function setButtonLabel(button, full, short) {
    const fullEl = button.querySelector(".btn-label-full");
    const shortEl = button.querySelector(".btn-label-short");
    if (fullEl) fullEl.textContent = full;
    if (shortEl) shortEl.textContent = short;
  }

  function setBusy(kind) {
    state.busy = kind || null;
    const busy = Boolean(kind);

    searchBtn.disabled = busy;
    routeBtn.disabled = busy;
    retryLive.disabled = busy;
    resetBtn.disabled = busy;
    swapBtn.disabled = busy || !(state.pointA && state.pointB);
    catsAll.disabled = busy;
    catsNone.disabled = busy;

    $$(".cat-cb").forEach((checkbox) => {
      checkbox.disabled = busy;
    });
    sliderControls.forEach((control) => {
      control.slider.disabled = busy;
      control.input.disabled = busy;
    });

    searchBtn.classList.toggle("is-loading", kind === "search");
    routeBtn.classList.toggle("is-loading", kind === "route");
    setButtonLabel(
      searchBtn,
      kind === "search" ? "Ищем…" : "Найти места",
      kind === "search" ? "Ищем…" : "Найти"
    );
    setButtonLabel(
      routeBtn,
      kind === "route" ? "Строим…" : "Построить маршрут",
      kind === "route" ? "Строим…" : "Маршрут"
    );
  }

  async function doSearch(options = {}) {
    if (state.busy || !ensurePoints()) return;

    commitNumberInputs();
    const forceLive = options.forceLive === true;
    const fit = options.fit !== false;
    const pad = Number(padSlider.value);
    const categories = selectedCategories();

    setBusy("search");
    hideNotice();
    clearRouteVisual();
    clearResultUI();
    state.routeData = null;
    updatePeek();

    const slowTimer = setTimeout(() => {
      if (state.busy === "search") {
        showToast("Overpass отвечает медленно — ждём ответ или переключимся на локальные данные.", "info");
      }
    }, 7000);

    try {
      const data = await apiPost(
        "/api/search-places",
        {
          point_a: state.pointA,
          point_b: state.pointB,
          pad,
          categories,
          force_live: forceLive,
        },
        forceLive ? 60000 : 45000
      );

      state.searched = true;
      state.bbox = data.bbox || null;
      state.allPlaces = Array.isArray(data.all_places)
        ? data.all_places
        : Array.isArray(data.places)
        ? data.places
        : [];
      state.source = data.source || null;
      state.provider = data.provider || null;
      state.providerError = data.provider_error || null;

      refreshFilter();
      updateSourcePill();
      updatePointsUI();

      if (data.notice) {
        showNotice(data.notice, { type: "warn", retry: Boolean(data.fallback) });
      } else {
        hideNotice();
      }

      drawPreview(false, data.bbox || null);
      if (fit) {
        if (isMobile()) setSheet(false);
        fitMapTo(data.bbox || null, { maxZoom: 16 });
      }

      if (forceLive) {
        showToast(
          data.fallback
            ? "Overpass пока недоступен — остались локальные данные."
            : "Overpass снова доступен — данные обновлены.",
          data.fallback ? "info" : "success"
        );
      } else if (data.fallback) {
        showToast("Overpass недоступен — показан локальный набор Саратова.", "info");
      } else {
        const count = state.filteredPlaces.length;
        showToast(`Найдено ${count} ${plural(count, ["место", "места", "мест"])}.`, "success");
      }

      updatePeek();
    } catch (error) {
      showToast(error.message || "Не удалось найти места.", "error");
    } finally {
      clearTimeout(slowTimer);
      setBusy(null);
    }
  }

  async function doRoute() {
    if (state.busy || !ensurePoints()) return;

    commitNumberInputs();
    const pad = Number(padSlider.value);
    const detour = Number(detourSlider.value);
    const stopsLimit = Number(stopsSlider.value);
    const categories = selectedCategories();

    setBusy("route");
    hideNotice();
    clearRouteVisual();
    clearResultUI();
    state.routeData = null;
    updatePeek();

    const slowTimer = setTimeout(() => {
      if (state.busy === "route") {
        showToast("Строим маршрут по улицам — это может занять несколько секунд.", "info");
      }
    }, 9000);

    try {
      const data = await apiPost(
        "/api/build-route",
        {
          point_a: state.pointA,
          point_b: state.pointB,
          pad,
          max_detour_km: detour,
          max_stops: stopsLimit,
          categories,
          priority_categories: categories,
        },
        60000
      );

      state.routeData = data;
      state.source = data.source || state.source;
      state.provider = data.provider || state.provider;
      state.providerError = null;
      updateSourcePill();

      if (isMobile()) setSheet(false);
      renderRoute(data, { fit: true });

      if (data.notice) {
        showNotice(data.notice, { type: "warn", retry: Boolean(data.fallback) });
      } else {
        hideNotice();
      }

      updatePeek();

      const stops = Array.isArray(data.stops) ? data.stops.length : 0;
      if (data.route && data.route.fallback) {
        showToast("Маршрутизатор недоступен — показана прямая линия.", "info");
      } else {
        showToast(
          stops
            ? `Маршрут готов: ${stops} ${plural(stops, ["остановка", "остановки", "остановок"])}.`
            : "Маршрут готов.",
          "success"
        );
      }

      if (!isMobile()) {
        resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } catch (error) {
      showToast(error.message || "Не удалось построить маршрут.", "error");
    } finally {
      clearTimeout(slowTimer);
      setBusy(null);
    }
  }

  // ------------------------------------------------------------
  // Действия пользователя
  // ------------------------------------------------------------

  function afterPointsChanged() {
    clearDerivedForPoints();
    renderPoints();
    drawPreview(false);
    updatePointsUI();
    updatePeek();
    saveSoon();
    syncPoints({ point_a: state.pointA, point_b: state.pointB });
  }

  function focusPoint(point) {
    if (!point) {
      showToast("Кликните по карте, чтобы поставить точку.", "info");
      return;
    }
    map.flyTo([point.lat, point.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
    if (isMobile()) setSheet(false);
  }

  function swapPoints() {
    if (!(state.pointA && state.pointB) || state.busy) return;
    const oldA = state.pointA;
    state.pointA = state.pointB;
    state.pointB = oldA;
    afterPointsChanged();
    showToast("Точки A и B поменяны местами.", "success");
  }

  function resetAll() {
    if (state.busy) return;
    state.pointA = null;
    state.pointB = null;
    clearDerivedForPoints();
    renderPoints();
    drawPreview(false);
    updatePointsUI();
    updatePeek();
    saveNow();
    syncPoints({ reset: true });
    map.closePopup();
    if (isMobile()) setSheet(false);
    showToast("Маршрут сброшен. Кликните по карте — новая точка A.", "info");
  }

  function onCategoriesChanged() {
    refreshFilter({ clearRoute: true });
    saveSoon();
  }

  function setAllCategories(checked) {
    if (state.busy) return;
    $$(".cat-cb").forEach((checkbox) => {
      checkbox.checked = checked;
    });
    onCategoriesChanged();
  }

  function setSheet(expanded) {
    if (!isMobile()) {
      sheetBody.inert = false;
      sheetBody.removeAttribute("aria-hidden");
      return;
    }
    const next = Boolean(expanded);
    sheet.classList.toggle("expanded", next);
    sheetHandle.setAttribute("aria-expanded", String(next));
    peek.setAttribute("aria-expanded", String(next));
    sheetBody.inert = !next;
    if (next) {
      sheetBody.removeAttribute("aria-hidden");
      sheetBody.scrollTop = 0;
    } else {
      sheetBody.setAttribute("aria-hidden", "true");
    }
  }

  function setLocateBusy(busy) {
    [locateBtn, locateCardBtn].forEach((button) => {
      if (!button) return;
      button.disabled = busy;
      button.classList.toggle("is-loading", busy);
    });
  }

  function locateUser() {
    if (!window.isSecureContext) {
      if (geoHint) geoHint.hidden = false;
      showToast(
        "Геолокация на телефоне работает только по HTTPS или на localhost. Сейчас страница открыта по HTTP.",
        "error"
      );
      return;
    }

    if (!("geolocation" in navigator)) {
      showToast("Геолокация не поддерживается этим браузером.", "error");
      return;
    }

    setLocateBusy(true);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocateBusy(false);

        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const accuracy = Math.max(25, Number(position.coords.accuracy) || 60);

        if (locationLayer) {
          map.removeLayer(locationLayer);
          locationLayer = null;
        }
        locationLayer = L.layerGroup().addTo(map);
        const accent = cssVar("--accent", "#2563eb");

        L.circle([lat, lon], {
          pane: "placePane",
          radius: Math.min(accuracy, 400),
          color: accent,
          weight: 1,
          fillColor: accent,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(locationLayer);

        const dot = L.circleMarker([lat, lon], {
          pane: "placePane",
          radius: 7,
          color: "#ffffff",
          weight: 2.5,
          fillColor: accent,
          fillOpacity: 1,
          interactive: false,
        })
          .bindPopup("Вы здесь")
          .addTo(locationLayer);

        map.flyTo([lat, lon], Math.max(map.getZoom(), 16), { duration: 0.7 });
        setTimeout(() => dot.openPopup(), 450);
        if (isMobile()) setSheet(false);
        showToast("Вы на карте. Кликните по ней, чтобы поставить точку маршрута.", "success");
      },
      (error) => {
        setLocateBusy(false);
        let message = "Не удалось определить местоположение.";
        if (error && error.code === 1) {
          message =
            "Доступ к геолокации запрещён. Разрешите его в настройках браузера для этого сайта.";
        } else if (error && error.code === 2) {
          message = "Геолокация недоступна. Проверьте, включён ли GPS и интернет.";
        } else if (error && error.code === 3) {
          message = "Геолокация заняла слишком много времени. Попробуйте ещё раз.";
        }
        showToast(message, "error");
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  // ------------------------------------------------------------
  // События
  // ------------------------------------------------------------

  map.on("click", (event) => {
    if (state.busy) return;

    const point = {
      lat: roundCoord(event.latlng.lat),
      lon: roundCoord(event.latlng.lng),
    };

    // Первый клик — A, второй — B, третий — новый маршрут.
    if (!state.pointA || state.pointB) {
      state.pointA = point;
      state.pointB = null;
    } else {
      state.pointB = point;
    }

    afterPointsChanged();
    if (isMobile()) setSheet(false);
  });

  map.on("moveend", saveSoon);

  mapHint.addEventListener("click", () => {
    /* подсказка не перехватывает клики по карте */
  });

  sheetHandle.addEventListener("click", () => {
    setSheet(!sheet.classList.contains("expanded"));
  });

  peek.addEventListener("click", () => {
    setSheet(!sheet.classList.contains("expanded"));
  });

  peek.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setSheet(!sheet.classList.contains("expanded"));
    }
  });

  pointARow.addEventListener("click", () => focusPoint(state.pointA));
  pointBRow.addEventListener("click", () => focusPoint(state.pointB));
  swapBtn.addEventListener("click", swapPoints);
  resetBtn.addEventListener("click", resetAll);

  catsAll.addEventListener("click", () => setAllCategories(true));
  catsNone.addEventListener("click", () => setAllCategories(false));
  categoriesEl.addEventListener("change", onCategoriesChanged);

  searchBtn.addEventListener("click", () => doSearch());
  routeBtn.addEventListener("click", () => doRoute());
  retryLive.addEventListener("click", () => doSearch({ forceLive: true, fit: false }));

  locateBtn.addEventListener("click", locateUser);
  locateCardBtn.addEventListener("click", locateUser);
  themeBtn.addEventListener("click", () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
  });

  stopsList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-stop]");
    if (!button) return;
    const index = Number(button.dataset.stop);
    const stop = state.routeData && state.routeData.stops ? state.routeData.stops[index] : null;
    if (!stop) return;

    map.flyTo([stop.lat, stop.lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
    const marker = stopMarkers[index];
    if (marker) {
      setTimeout(() => marker.openPopup(), 350);
    }
    if (isMobile()) setSheet(false);
  });

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => map.invalidateSize(), 150);
  });

  window.addEventListener("orientationchange", () => {
    setTimeout(() => map.invalidateSize(), 300);
  });

  if (mobileMedia.addEventListener) {
    mobileMedia.addEventListener("change", () => {
      if (isMobile()) {
        setSheet(false);
      } else {
        sheet.classList.remove("expanded");
        sheetBody.inert = false;
        sheetBody.removeAttribute("aria-hidden");
      }
      map.invalidateSize();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveNow();
  });

  window.addEventListener("pagehide", saveNow);

  // ------------------------------------------------------------
  // Старт
  // ------------------------------------------------------------

  restoreSettings();

  sliderControls.forEach(setupSliderControl);

  if (!window.isSecureContext) {
    if (geoHint) geoHint.hidden = false;
  } else if (!("geolocation" in navigator) && geoHint) {
    geoHint.textContent = "Этот браузер не поддерживает геолокацию.";
    geoHint.hidden = false;
  }

  applyTheme(currentTheme, { persist: false });
  renderPoints();
  drawPreview(false);
  updateSourcePill();
  updateCounts();
  updatePointsUI();
  updatePeek();
  setSheet(false);
})();
