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
  const pointALabel = $("#pointALabel");
  const pointAValue = $("#pointAValue");
  const pointBValue = $("#pointBValue");
  const swapBtn = $("#swapBtn");
  const resetBtn = $("#resetBtn");
  const modeMe = $("#modeMe");
  const modeManual = $("#modeManual");
  const pointsHint = $("#pointsHint");
  const geoStatus = $("#geoStatus");

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
  const themeBtn = $("#themeBtn");
  const toast = $("#toast");
  const photoNote = $("#photoNote");

  const navPanel = $("#navPanel");
  const navArrow = $("#navArrow");
  const navInstruction = $("#navInstruction");
  const navSub = $("#navSub");
  const navMeta = $("#navMeta");
  const navVoiceBtn = $("#navVoiceBtn");
  const navStopBtn = $("#navStopBtn");
  const navStartBtn = $("#navStartBtn");
  const navStartFab = $("#navStartFab");
  const followBtn = $("#followBtn");

  const mobileMedia = window.matchMedia(MOBILE_QUERY);

  const state = {
    mode: "me",
    userLocation: null,
    geoBusy: false,
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
  let routeImageToken = 0;
  let userLayer = null;
  let userMarker = null;
  let userAccuracy = null;
  const placeImageCache = new Map();

  const nav = {
    active: false,
    watchId: null,
    routeData: null,
    coords: [],
    cumulative: [],
    totalM: 0,
    steps: [],
    stepEnds: [],
    lastPos: null,
    lastHeading: 0,
    follow: true,
    voice: true,
    layer: null,
    marker: null,
    accuracy: null,
    progressLine: null,
    arrived: false,
    offRoute: false,
    announcedTurnKey: null,
    announcedNearKey: null,
    announcedOffRoute: false,
    wakeLock: null,
    firstFix: true,
  };

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
    if (state.userLocation) renderUserLocation();
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
  // Автоопределение местоположения и режимы старта
  // ------------------------------------------------------------

  function setGeoStatus(message, type) {
    if (!message) {
      geoStatus.hidden = true;
      geoStatus.textContent = "";
      delete geoStatus.dataset.type;
      return;
    }
    geoStatus.hidden = false;
    geoStatus.textContent = message;
    geoStatus.dataset.type = type || "info";
  }

  function renderUserLocation() {
    if (userLayer) {
      map.removeLayer(userLayer);
      userLayer = null;
      userMarker = null;
      userAccuracy = null;
    }
    if (!state.userLocation || nav.active) return;

    const { lat, lon, accuracy } = state.userLocation;
    const accent = cssVar("--accent", "#2563eb");
    userLayer = L.layerGroup().addTo(map);

    userAccuracy = L.circle([lat, lon], {
      pane: "placePane",
      radius: Math.min(Math.max(accuracy || 30, 10), 200),
      color: accent,
      weight: 1,
      fillColor: accent,
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(userLayer);

    userMarker = L.circleMarker([lat, lon], {
      pane: "placePane",
      radius: 7,
      color: "#ffffff",
      weight: 2.5,
      fillColor: accent,
      fillOpacity: 1,
      interactive: false,
    })
      .bindTooltip("Вы здесь", { direction: "top", offset: [0, -4] })
      .addTo(userLayer);
  }

  function detectUserLocation(options = {}) {
    const setAsA = options.setAsA !== false;
    const center = Boolean(options.center);
    const silent = Boolean(options.silent);

    if (!window.isSecureContext) {
      const message = "Автоопределение местоположения работает только по HTTPS.";
      setGeoStatus(message, "error");
      if (!silent) showToast(message, "error");
      return Promise.resolve(null);
    }
    if (!("geolocation" in navigator)) {
      const message = "Этот браузер не поддерживает геолокацию.";
      setGeoStatus(message, "error");
      if (!silent) showToast(message, "error");
      return Promise.resolve(null);
    }
    if (state.geoBusy) return Promise.resolve(null);

    state.geoBusy = true;
    setGeoStatus("Определяем местоположение…", "info");
    updatePointsUI();
    updatePeek();

    return new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        state.geoBusy = false;
        updatePointsUI();
        updatePeek();
        resolve(value);
      };

      const onSuccess = (position) => {
        const coords = position && position.coords ? position.coords : {};
        const lat = Number(coords.latitude);
        const lon = Number(coords.longitude);
        const accuracy = Math.max(5, Number(coords.accuracy) || 30);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          const message = "Не удалось получить корректные координаты.";
          setGeoStatus(message, "error");
          if (!silent) showToast(message, "error");
          finish(null);
          return;
        }

        state.userLocation = { lat, lon, accuracy };
        renderUserLocation();
        if (center) {
          map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: false });
        }

        if (state.mode === "me" && setAsA) {
          state.pointA = normalizePoint({ lat, lon });
          afterPointsChanged();
        } else {
          renderPoints();
          updatePointsUI();
          updatePeek();
          saveSoon();
        }

        setGeoStatus("", null);
        finish(state.userLocation);
      };

      const onError = (error) => {
        let message = "Не удалось определить местоположение.";
        if (error && error.code === 1) {
          message = "Доступ к геолокации запрещён. Разрешите его для этого сайта.";
        } else if (error && error.code === 2) {
          message = "GPS недоступен. Проверьте, включена ли геолокация.";
        } else if (error && error.code === 3) {
          message = "Определение местоположения заняло слишком много времени.";
        }
        setGeoStatus(message, "error");
        if (!silent) showToast(message, "error");

        if (state.mode === "me" && setAsA && !state.userLocation) {
          state.pointA = null;
          afterPointsChanged();
        }
        finish(null);
      };

      try {
        navigator.geolocation.getCurrentPosition(onSuccess, onError, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 60000,
        });
      } catch (_error) {
        const message = "Не удалось включить геолокацию.";
        setGeoStatus(message, "error");
        if (!silent) showToast(message, "error");
        finish(null);
      }
    });
  }

  function setMode(mode) {
    if (state.busy) return;
    const next = mode === "manual" ? "manual" : "me";
    if (next === state.mode) {
      updatePointsUI();
      return;
    }

    state.mode = next;
    setGeoStatus("", null);

    if (next === "me") {
      if (state.userLocation) {
        state.pointA = normalizePoint(state.userLocation);
        afterPointsChanged();
      } else {
        detectUserLocation({ setAsA: true, center: true, silent: false });
      }
      renderUserLocation();
    } else {
      if (!state.pointA && state.userLocation) {
        state.pointA = normalizePoint(state.userLocation);
        afterPointsChanged();
      } else {
        renderPoints();
        updatePointsUI();
        updatePeek();
        saveSoon();
      }
      renderUserLocation();
    }

    updatePointsUI();
    updatePeek();
    saveSoon();
  }

  // ------------------------------------------------------------
  // Навигация по GPS
  // ------------------------------------------------------------

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dp = ((lat2 - lat1) * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const p1 = (lat1 * Math.PI) / 180;
    const p2 = (lat2 * Math.PI) / 180;
    const dl = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function navDistanceText(meters) {
    const m = Math.max(0, Number(meters) || 0);
    if (m < 10) return `${Math.round(m)} м`;
    if (m < 100) return `${Math.round(m / 5) * 5} м`;
    if (m < 1000) return `${Math.round(m / 10) * 10} м`;
    return `${(m / 1000).toFixed(1).replace(".0", "")} км`;
  }

  function navAheadText(meters) {
    const m = Math.max(0, Number(meters) || 0);
    return m < 12 ? "сейчас" : `через ${navDistanceText(m)}`;
  }

  function navSpeechDistance(meters) {
    const m = Math.max(0, Math.round((Number(meters) || 0) / 10) * 10);
    if (m < 10) return "несколько метров";
    if (m < 1000) return `${m} метров`;
    return `${(m / 1000).toFixed(1)} километра`;
  }

  function navRemainingText(remainingM) {
    if (!nav.routeData || !nav.routeData.route) return "";
    const totalMin = Number(nav.routeData.route.duration_min) || 0;
    const ratio = nav.totalM > 0 ? Math.max(0, Math.min(1, remainingM / nav.totalM)) : 0;
    const minutes = totalMin * ratio;
    if (minutes < 0.75) return "меньше минуты";
    const rounded = Math.round(minutes);
    const eta = new Date(Date.now() + minutes * 60000).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (rounded < 60) return `${rounded} мин · прибытие ${eta}`;
    const hours = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return `${hours} ч${rest ? ` ${rest} мин` : ""} · прибытие ${eta}`;
  }

  function navSideword(modifier, fork) {
    const mod = String(modifier || "").toLowerCase();
    if (mod.includes("left")) return fork ? "левее" : "налево";
    if (mod.includes("right")) return fork ? "правее" : "направо";
    return "прямо";
  }

  function navStepText(step) {
    if (!step) return "Идите к финишу";
    const type = String(step.type || "continue").toLowerCase();
    const modifier = String(step.modifier || "").toLowerCase();
    const name = step.name ? ` на ${step.name}` : "";
    const side = navSideword(modifier, false);

    if (type === "arrive") return "Идите к финишу";
    if (type === "depart") return "Начните движение";
    if (type === "uturn" || modifier.includes("uturn")) return "Развернитесь";
    if (type === "turn") {
      if (modifier.includes("straight")) return "Идите прямо";
      const prefix = modifier.includes("sharp")
        ? "Резко поверните"
        : modifier.includes("slight")
        ? "Плавно поверните"
        : "Поверните";
      return `${prefix} ${side}${name}`;
    }
    if (type === "end of road") return `В конце дороги поверните ${side}`;
    if (type === "fork") return `Держитесь ${navSideword(modifier, true)}`;
    if (type === "roundabout" || type === "rotary") {
      return step.exit ? `На круговом движении сверните на ${step.exit}-й съезд` : "Пройдите круговое движение";
    }
    if (type === "merge") return "Присоединитесь к дороге";
    if (type === "new name" || type === "continue") {
      if (modifier.includes("left") || modifier.includes("right")) {
        return `Поверните ${side}${name}`;
      }
      return step.name ? `Продолжайте движение по ${step.name}` : "Идите прямо";
    }
    return step.name ? `Продолжайте движение по ${step.name}` : "Идите прямо";
  }

  function navArrowFor(step, offRoute) {
    if (offRoute) return "⟲";
    if (!step) return "⚑";
    const type = String(step.type || "").toLowerCase();
    const modifier = String(step.modifier || "").toLowerCase();
    if (type === "arrive") return "⚑";
    if (type === "roundabout" || type === "rotary") return "↻";
    if (type === "uturn" || modifier.includes("uturn")) return "↺";
    if (modifier.includes("slight") && modifier.includes("left")) return "↖";
    if (modifier.includes("slight") && modifier.includes("right")) return "↗";
    if (modifier.includes("sharp") && modifier.includes("left")) return "↰";
    if (modifier.includes("sharp") && modifier.includes("right")) return "↱";
    if (modifier.includes("left")) return "←";
    if (modifier.includes("right")) return "→";
    return "↑";
  }

  function buildNavGeometry(route) {
    const raw = route && Array.isArray(route.geometry) ? route.geometry : [];
    const coords = [];
    for (const point of raw) {
      const lat = Number(point && point[0]);
      const lon = Number(point && point[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lat, lon]);
    }
    const cumulative = [0];
    let total = 0;
    for (let i = 1; i < coords.length; i += 1) {
      total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
      cumulative.push(total);
    }
    return { coords, cumulative, total };
  }

  function nearestOnRoute(lat, lon) {
    if (nav.coords.length < 2) return null;
    let best = null;
    for (let i = 0; i < nav.coords.length - 1; i += 1) {
      const [lat1, lon1] = nav.coords[i];
      const [lat2, lon2] = nav.coords[i + 1];
      const midLat = ((lat1 + lat2) / 2) * (Math.PI / 180);
      const kx = 111320 * Math.cos(midLat);
      const ky = 110540;
      const x2 = (lon2 - lon1) * kx;
      const y2 = (lat2 - lat1) * ky;
      const px = (lon - lon1) * kx;
      const py = (lat - lat1) * ky;
      const lengthSq = x2 * x2 + y2 * y2;
      let t = lengthSq > 0 ? (px * x2 + py * y2) / lengthSq : 0;
      t = Math.max(0, Math.min(1, t));
      const distance = Math.hypot(px - x2 * t, py - y2 * t);
      if (!best || distance < best.distance) {
        const segment = nav.cumulative[i + 1] - nav.cumulative[i];
        best = {
          distance,
          index: i,
          along: nav.cumulative[i] + segment * t,
        };
      }
    }
    return best;
  }

  function coordsUntil(along) {
    if (along <= 0 || nav.coords.length < 2) return [];
    if (along >= nav.totalM) return nav.coords.slice();
    const result = [nav.coords[0]];
    for (let i = 1; i < nav.coords.length; i += 1) {
      if (nav.cumulative[i] <= along) {
        result.push(nav.coords[i]);
        continue;
      }
      const previous = nav.cumulative[i - 1];
      const segment = nav.cumulative[i] - previous;
      const t = segment > 0 ? Math.max(0, Math.min(1, (along - previous) / segment)) : 0;
      result.push([
        nav.coords[i - 1][0] + (nav.coords[i][0] - nav.coords[i - 1][0]) * t,
        nav.coords[i - 1][1] + (nav.coords[i][1] - nav.coords[i - 1][1]) * t,
      ]);
      break;
    }
    return result;
  }

  function stepIndexFor(progress) {
    if (!nav.stepEnds.length) return -1;
    for (let i = 0; i < nav.stepEnds.length; i += 1) {
      if (progress <= nav.stepEnds[i] + 0.5) return i;
    }
    return nav.stepEnds.length - 1;
  }

  function routeHasGeometry() {
    return Boolean(
      state.routeData &&
        state.routeData.route &&
        Array.isArray(state.routeData.route.geometry) &&
        state.routeData.route.geometry.length >= 2
    );
  }

  function updateNavStartButtons() {
    const canStart = routeHasGeometry() && !nav.active;
    navStartBtn.hidden = !canStart;
    navStartFab.hidden = !canStart;
  }

  function updateVoiceButton() {
    navVoiceBtn.classList.toggle("is-muted", !nav.voice);
    navVoiceBtn.setAttribute("aria-pressed", String(nav.voice));
    const label = nav.voice ? "Выключить голос" : "Включить голос";
    navVoiceBtn.title = label;
    navVoiceBtn.setAttribute("aria-label", label);
  }

  function speak(text) {
    if (!nav.voice || !text) return;
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ru-RU";
      utterance.rate = 1;
      utterance.pitch = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (_error) {
      /* голос недоступен — навигация продолжает работать текстом */
    }
  }

  async function requestWakeLock() {
    if (!nav.active || nav.arrived || nav.wakeLock || !("wakeLock" in navigator)) return;
    try {
      nav.wakeLock = await navigator.wakeLock.request("screen");
      nav.wakeLock.addEventListener("release", () => {
        nav.wakeLock = null;
      });
    } catch (_error) {
      /* Wake Lock не обязателен */
    }
  }

  function releaseWakeLock() {
    try {
      if (nav.wakeLock) nav.wakeLock.release();
    } catch (_error) {
      /* ignore */
    }
    nav.wakeLock = null;
  }

  function ensureNavMarker(lat, lon, heading, accuracy) {
    const accent = cssVar("--accent", "#2563eb");
    if (!nav.marker) {
      nav.marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: "nav-marker",
          html: '<span class="nav-heading"></span><span class="nav-dot"></span>',
          iconSize: [46, 46],
          iconAnchor: [23, 23],
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1200,
      }).addTo(nav.layer);
    } else {
      nav.marker.setLatLng([lat, lon]);
    }

    const markerEl = nav.marker.getElement();
    if (markerEl) markerEl.style.setProperty("--heading", `${heading || 0}deg`);

    if (!nav.accuracy) {
      nav.accuracy = L.circle([lat, lon], {
        pane: "placePane",
        radius: Math.min(Math.max(accuracy, 10), 200),
        color: accent,
        weight: 1,
        fillColor: accent,
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(nav.layer);
    } else {
      nav.accuracy.setLatLng([lat, lon]);
      nav.accuracy.setRadius(Math.min(Math.max(accuracy, 10), 200));
    }
  }

  function updateNavigationPanel(accuracy, nearest, remaining) {
    let arrow = "↑";
    let instruction = "Идите по маршруту";
    let sub = navAheadText(remaining);
    let meta = `Осталось ${navDistanceText(remaining)} · ${navRemainingText(remaining)}`;

    navPanel.classList.toggle("is-off-route", Boolean(nav.offRoute));
    navPanel.classList.toggle("is-arrived", Boolean(nav.arrived));

    if (nav.arrived) {
      arrow = "✓";
      instruction = "Вы на месте";
      sub = "Маршрут завершён";
      meta = "Можно завершить навигацию";
    } else if (nav.offRoute && nearest) {
      arrow = "⟲";
      instruction = "Вернитесь на маршрут";
      sub = `до линии ${navDistanceText(nearest.distance)}`;
    } else if (nav.steps.length && nearest) {
      const index = stepIndexFor(nav.progress);
      const target = nav.steps[index + 1];
      if (index >= 0 && target) {
        const distance = Math.max(0, (nav.stepEnds[index] || 0) - nav.progress);
        arrow = navArrowFor(target, false);
        instruction = navStepText(target);
        sub = `${target.name ? `на ${target.name} · ` : ""}${navAheadText(distance)}`;
      } else {
        arrow = "⚑";
        instruction = "Идите к финишу";
        sub = navAheadText(remaining);
      }
    }

    navArrow.textContent = arrow;
    navInstruction.textContent = instruction;
    navSub.textContent = sub;
    navMeta.textContent = meta;
    navMeta.title = `Точность GPS: ±${Math.round(accuracy)} м`;
  }

  function announceNavigation(nearest, remaining) {
    if (nav.arrived) return;

    if (nav.offRoute) {
      if (!nav.announcedOffRoute) {
        nav.announcedOffRoute = true;
        speak("Вы отклонились от маршрута. Вернитесь на линию маршрута.");
      }
      return;
    }

    if (nav.announcedOffRoute) {
      nav.announcedOffRoute = false;
      speak("Вы снова на маршруте.");
    }

    if (!nav.steps.length || !nearest) return;
    const index = stepIndexFor(nav.progress);
    const target = nav.steps[index + 1];
    if (!target) return;

    const distance = Math.max(0, (nav.stepEnds[index] || 0) - nav.progress);
    const key = `${index}:${target.type}:${target.modifier}:${target.name}:${target.exit || ""}`;

    if (key !== nav.announcedTurnKey) {
      nav.announcedTurnKey = key;
      nav.announcedNearKey = null;
      if (target.type === "arrive") {
        speak(distance < 25 ? "Вы почти на месте." : "Идите к финишу.");
      } else if (distance > 20) {
        speak(`Через ${navSpeechDistance(distance)} ${navStepText(target).toLowerCase()}.`);
      } else {
        speak(navStepText(target));
      }
    } else if (distance <= 15 && nav.announcedNearKey !== key) {
      nav.announcedNearKey = key;
      speak(target.type === "arrive" ? "Вы почти на месте." : navStepText(target));
    }
  }

  function onArrival() {
    if (nav.arrived) return;
    nav.arrived = true;
    nav.offRoute = false;
    if (nav.progressLine) nav.progressLine.setLatLngs(nav.coords.slice());
    navArrow.textContent = "✓";
    navInstruction.textContent = "Вы на месте";
    navSub.textContent = "Маршрут завершён";
    navMeta.textContent = "Можно завершить навигацию";
    navPanel.classList.remove("is-off-route");
    navPanel.classList.add("is-arrived");
    if (nav.watchId !== null) {
      navigator.geolocation.clearWatch(nav.watchId);
      nav.watchId = null;
    }
    releaseWakeLock();
    speak("Вы на месте. Навигация завершена.");
    showToast("Вы на месте.", "success");
  }

  function onNavPosition(position) {
    if (!nav.active) return;
    const coords = position && position.coords ? position.coords : {};
    const lat = Number(coords.latitude);
    const lon = Number(coords.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const accuracy = Math.max(5, Number(coords.accuracy) || 30);
    state.userLocation = { lat, lon, accuracy };
    let heading = Number(coords.heading);
    if (!Number.isFinite(heading) || heading < 0) {
      if (nav.lastPos) {
        const moved = haversineMeters(nav.lastPos[0], nav.lastPos[1], lat, lon);
        if (moved > 1.5) {
          heading = bearingDegrees(nav.lastPos[0], nav.lastPos[1], lat, lon);
        }
      }
      if (!Number.isFinite(heading) || heading < 0) heading = nav.lastHeading || 0;
    }
    nav.lastHeading = heading;
    nav.lastPos = [lat, lon];

    ensureNavMarker(lat, lon, heading, accuracy);

    if (nav.follow) {
      const target = L.latLng(lat, lon);
      if (nav.firstFix || map.getCenter().distanceTo(target) > 12) {
        map.setView(target, Math.max(map.getZoom(), 17), { animate: false });
      }
    }
    nav.firstFix = false;

    const nearest = nearestOnRoute(lat, lon);
    if (!nearest) {
      navInstruction.textContent = "Идите по маршруту";
      navSub.textContent = "GPS работает";
      return;
    }

    nav.progress = nearest.along;
    nav.offRoute = nearest.distance > Math.max(35, accuracy * 1.5);
    if (nav.progressLine) nav.progressLine.setLatLngs(coordsUntil(nearest.along));

    const remaining = Math.max(0, nav.totalM - nearest.along);
    if (remaining <= 12) {
      onArrival();
      return;
    }

    updateNavigationPanel(accuracy, nearest, remaining);
    announceNavigation(nearest, remaining);
  }

  function onNavError(error) {
    if (!nav.active) return;
    if (error && error.code === 1) {
      showToast("Нет доступа к GPS. Разрешите геолокацию для этого сайта.", "error");
      navInstruction.textContent = "Нет доступа к GPS";
      navSub.textContent = "Разрешите геолокацию в браузере";
      navMeta.textContent = "";
      stopNavigation({ silent: true });
      return;
    }
    navInstruction.textContent = "Ждём сигнал GPS…";
    navSub.textContent =
      error && error.code === 2
        ? "GPS недоступен — выйдите на открытое место"
        : "Проверьте, что GPS включён";
    navMeta.textContent = "";
  }

  function startNavigation() {
    if (nav.active) return;
    if (!routeHasGeometry()) {
      showToast("Сначала постройте маршрут.", "info");
      return;
    }
    if (!window.isSecureContext) {
      showToast("GPS на телефоне работает только по HTTPS. Откройте адрес https://…", "error");
      return;
    }
    if (!("geolocation" in navigator)) {
      showToast("GPS не поддерживается этим браузером.", "error");
      return;
    }

    const route = state.routeData.route;
    const geometry = buildNavGeometry(route);
    if (geometry.coords.length < 2) {
      showToast("В маршруте нет геометрии для навигации.", "error");
      return;
    }

    stopNavigation({ silent: true });
    nav.active = true;
    if (userLayer) {
      map.removeLayer(userLayer);
      userLayer = null;
      userMarker = null;
      userAccuracy = null;
    }
    nav.routeData = state.routeData;
    nav.coords = geometry.coords;
    nav.cumulative = geometry.cumulative;
    nav.totalM = geometry.total;
    nav.steps = Array.isArray(route.steps) ? route.steps : [];
    let accumulated = 0;
    const stepEnds = nav.steps.map((step) => {
      accumulated += Math.max(0, Number(step.distance_m) || 0);
      return accumulated;
    });
    nav.stepEnds =
      accumulated > 0
        ? stepEnds.map((value) => (value * nav.totalM) / accumulated)
        : [];
    nav.progress = 0;
    nav.arrived = false;
    nav.offRoute = false;
    nav.follow = true;
    nav.firstFix = true;
    nav.lastPos = null;
    nav.lastHeading = 0;
    nav.announcedTurnKey = null;
    nav.announcedNearKey = null;
    nav.announcedOffRoute = false;

    nav.layer = L.layerGroup().addTo(map);
    nav.progressLine = L.polyline([], {
      pane: "routePane",
      color: cssVar("--green", "#059669"),
      weight: 5,
      opacity: 0.75,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }).addTo(nav.layer);

    navPanel.hidden = false;
    navPanel.classList.remove("is-arrived", "is-off-route");
    navArrow.textContent = "◎";
    navInstruction.textContent = "Ждём GPS…";
    navSub.textContent = "Разрешите доступ к геопозиции";
    navMeta.textContent = "";
    navStartBtn.hidden = true;
    navStartFab.hidden = true;
    followBtn.hidden = true;
    document.body.classList.add("navigating");
    mapHint.classList.add("hidden");
    if (isMobile()) setSheet(false);
    updateVoiceButton();
    map.setView(nav.coords[0], Math.max(map.getZoom(), 16));

    try {
      nav.watchId = navigator.geolocation.watchPosition(onNavPosition, onNavError, {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 20000,
      });
    } catch (error) {
      showToast("Не удалось включить GPS. Проверьте разрешение браузера.", "error");
      stopNavigation({ silent: true });
      return;
    }
    requestWakeLock();
    speak("Навигация началась. Следите за подсказками.");
  }

  function stopNavigation(options = {}) {
    if (!nav.active) return;
    if (nav.watchId !== null) {
      try {
        navigator.geolocation.clearWatch(nav.watchId);
      } catch (_error) {
        /* ignore */
      }
      nav.watchId = null;
    }
    releaseWakeLock();
    nav.active = false;
    nav.arrived = false;
    nav.offRoute = false;
    nav.lastPos = null;
    nav.firstFix = true;
    if (nav.layer) {
      map.removeLayer(nav.layer);
      nav.layer = null;
    }
    nav.marker = null;
    nav.accuracy = null;
    nav.progressLine = null;
    navPanel.hidden = true;
    navPanel.classList.remove("is-arrived", "is-off-route");
    document.body.classList.remove("navigating");
    followBtn.hidden = true;
    renderUserLocation();
    updateNavStartButtons();
    updatePointsUI();
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch (_error) {
      /* ignore */
    }
    if (!options.silent) showToast("Навигация завершена.", "info");
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
          mode: state.mode,
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

    state.mode = saved.mode === "manual" ? "manual" : "me";

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

    const aMatchesUser =
      state.pointA &&
      state.userLocation &&
      haversineMeters(
        state.pointA.lat,
        state.pointA.lon,
        state.userLocation.lat,
        state.userLocation.lon
      ) < 20;

    if (state.pointA && !aMatchesUser) {
      markerA = L.marker([state.pointA.lat, state.pointA.lon], {
        icon: pointIcon("A"),
        title: state.mode === "me" ? "Моё местоположение" : "Точка A",
        riseOnHover: true,
        bubblingMouseEvents: false,
      }).addTo(map);
      markerA.bindPopup(state.mode === "me" ? "Моё местоположение" : "Точка A");
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

  function popupImageHtml(image) {
    if (!image || !image.url) return "";
    const details = [image.artist, image.license].filter(Boolean).map(esc).join(" · ");
    const source = image.page_url
      ? `<a href="${esc(image.page_url)}" target="_blank" rel="noopener">${esc(
          image.source || "Wikimedia Commons"
        )}</a>`
      : esc(image.source || "Wikimedia Commons");
    return (
      `<img class="popup-photo" src="${esc(image.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` +
      `<div class="popup-credit">${details ? `${details} · ` : ""}${source}</div>`
    );
  }

  function popupPlace(place, image) {
    const meta = CATEGORY_META[place.category] || CATEGORY_META.tourism_view;
    const cat = CATEGORY_META[place.category] ? place.category : "tourism_view";
    return (
      `<div class="popup">` +
      popupImageHtml(image) +
      `<div class="popup-cat" data-cat="${esc(cat)}"><span class="popup-dot"></span>` +
      `${esc(place.category_label || meta.label)}</div>` +
      `<b>${esc(place.name || "Место")}</b>` +
      `</div>`
    );
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
      marker.bindPopup(popupPlace(place, null));

      let imageApplied = false;
      marker.on("popupopen", async () => {
        if (imageApplied) return;
        const image = await fetchPlaceImage(place);
        if (image && marker.isPopupOpen()) {
          marker.setPopupContent(popupPlace(place, image));
          imageApplied = true;
        }
      });

      marker.addTo(placeLayer);
    });
  }

  function clearRouteVisual() {
    routeLayer.clearLayers();
    stopMarkers = [];
  }

  function clearResultUI() {
    if (nav.active) stopNavigation({ silent: true });
    routeImageToken += 1;
    resultCard.hidden = true;
    navStartBtn.hidden = true;
    navStartFab.hidden = true;
    stopsList.innerHTML = "";
    resultBadge.textContent = "";
    resultBadge.className = "result-badge";
    metricDistance.textContent = "—";
    metricDuration.textContent = "—";
    metricStops.textContent = "—";
    resultNote.hidden = true;
    resultNote.textContent = "";
    photoNote.hidden = true;
  }

  function stopPopup(stop, index, image) {
    const cat = CATEGORY_META[stop.category] ? stop.category : "tourism_view";
    return (
      `<div class="popup">` +
      popupImageHtml(image) +
      `<div class="popup-cat" data-cat="${esc(cat)}"><span class="popup-dot"></span>` +
      `Остановка ${index + 1}${stop.category_label ? ` · ${esc(stop.category_label)}` : ""}</div>` +
      `<b>${esc(stop.name || "Место")}</b>` +
      `</div>`
    );
  }

  function renderRoute(data, options = {}) {
    clearRouteVisual();
    const imageToken = ++routeImageToken;

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
      marker.bindPopup(stopPopup(stop, index, null));
      stopMarkers[index] = marker;
    });

    updateResultUI(data);
    hydrateStopImages(stops, imageToken);
  }

  function updateStopThumb(index, image) {
    if (!image || !image.url) return;
    const thumb = stopsList.querySelector(`[data-thumb="${index}"]`);
    if (!thumb) return;

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => thumb.classList.add("has-image"));
    img.addEventListener("error", () => {
      img.remove();
      thumb.classList.remove("has-image");
      const credit = stopsList.querySelector(`[data-credit="${index}"]`);
      if (credit) credit.hidden = true;
    });
    thumb.prepend(img);

    const credit = stopsList.querySelector(`[data-credit="${index}"]`);
    if (credit) {
      const parts = [image.artist, image.license].filter(Boolean);
      credit.textContent = parts.length ? `Фото: ${parts.join(" · ")}` : "Фото: Wikimedia Commons";
      credit.title = parts.join(" · ");
      credit.hidden = false;
    }
    photoNote.hidden = false;
  }

  async function hydrateStopImages(stops, token) {
    const max = Math.min(stops.length, 12);
    let cursor = 0;

    async function worker() {
      while (cursor < max) {
        const index = cursor++;
        if (token !== routeImageToken) return;
        const stop = stops[index];
        const image = await fetchPlaceImage(stop);
        if (!image || token !== routeImageToken) continue;
        updateStopThumb(index, image);
        const marker = stopMarkers[index];
        if (marker) marker.setPopupContent(stopPopup(stop, index, image));
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, max) }, worker));
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
    photoNote.hidden = true;

    if (stops.length) {
      stopsList.innerHTML = stops
        .map((stop, index) => {
          const name = esc(stop.name || "Без названия");
          const meta = esc(stop.category_label || "");
          const cat = CATEGORY_META[stop.category] ? stop.category : "tourism_view";
          return (
            `<button class="stop" type="button" data-stop="${index}" ` +
            `aria-label="Показать остановку ${index + 1}: ${name}">` +
            `<span class="stop-thumb" data-thumb="${index}" data-cat="${esc(cat)}" aria-hidden="true">` +
            `<span class="stop-thumb-fallback">${index + 1}</span>` +
            `<span class="stop-thumb-badge">${index + 1}</span>` +
            `</span>` +
            `<span class="stop-info"><span class="stop-name">${name}</span>` +
            `<span class="stop-meta">${meta}</span>` +
            `<span class="stop-credit" data-credit="${index}" hidden></span></span>` +
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

    updateNavStartButtons();
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

    if (state.mode === "me") {
      if (!state.pointA) {
        peekTitle.textContent = state.geoBusy ? "Определяем местоположение…" : "Откуда идём?";
        peekSub.textContent = state.geoBusy
          ? "Разрешите доступ к GPS"
          : "Нажмите на «Моё местоположение»";
        return;
      }
      if (!state.pointB) {
        peekTitle.textContent = "Вы здесь";
        peekSub.textContent = "Тапните по карте — точка B";
        return;
      }
      peekTitle.textContent = "Маршрут от вас";
      peekSub.textContent = "Откройте настройки и постройте маршрут";
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
    const busy = Boolean(state.busy);
    const isMe = state.mode === "me";

    modeMe.classList.toggle("is-active", isMe);
    modeManual.classList.toggle("is-active", !isMe);
    modeMe.setAttribute("aria-pressed", String(isMe));
    modeManual.setAttribute("aria-pressed", String(!isMe));
    modeMe.disabled = busy;
    modeManual.disabled = busy;

    pointALabel.textContent = isMe ? "Моё местоположение" : "Точка A";
    if (isMe) {
      if (state.userLocation) {
        pointAValue.textContent = formatPoint(state.pointA || state.userLocation);
      } else if (state.geoBusy) {
        pointAValue.textContent = "Определяем местоположение…";
      } else if (state.pointA) {
        pointAValue.textContent = formatPoint(state.pointA);
      } else {
        pointAValue.textContent = "Нажмите, чтобы определить";
      }
    } else {
      pointAValue.textContent = state.pointA ? formatPoint(state.pointA) : "Кликните по карте";
    }
    pointBValue.textContent = state.pointB ? formatPoint(state.pointB) : "Кликните по карте";
    pointARow.classList.toggle("filled", Boolean(state.pointA));
    pointBRow.classList.toggle("filled", Boolean(state.pointB));
    pointARow.classList.toggle("gps", isMe);
    pointARow.disabled = busy || (isMe && state.geoBusy);
    pointARow.title = isMe ? "Обновить моё местоположение" : "Показать точку A на карте";
    pointARow.setAttribute(
      "aria-label",
      isMe ? "Обновить моё местоположение" : "Показать точку A на карте"
    );

    swapBtn.disabled = busy || isMe || !(state.pointA && state.pointB);
    resetBtn.disabled = busy;

    if (isMe) {
      pointsHint.textContent =
        "Точка A — ваше местоположение. Кликните по карте, чтобы поставить B. Нажмите на A, чтобы обновить GPS.";
    } else {
      pointsHint.textContent =
        "Первый клик по карте ставит точку A, второй — B. Следующий клик начнёт новый маршрут.";
    }

    if (isMe) {
      if (!state.pointA) {
        mapHintText.textContent = state.geoBusy
          ? "Определяем местоположение…"
          : "Нажмите на «Моё местоположение»";
      } else if (!state.pointB) {
        mapHintText.textContent = "Кликните по карте — точка B";
      } else {
        mapHintText.textContent = "Клик — новая точка B";
      }
    } else if (!state.pointA) {
      mapHintText.textContent = "Кликните по карте — точка A";
    } else if (!state.pointB) {
      mapHintText.textContent = "Кликните по карте — точка B";
    } else {
      mapHintText.textContent = "Клик — новый маршрут";
    }
    mapHint.classList.toggle("hidden", Boolean(state.pointA && state.pointB) && !nav.active);
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

  async function fetchPlaceImage(place) {
    if (!place) return null;
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const key = `${lat.toFixed(4)},${lon.toFixed(4)},${String(place.name || "").toLowerCase()}`;
    if (placeImageCache.has(key)) return placeImageCache.get(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const params = new URLSearchParams({
      name: place.name || "",
      lat: String(lat),
      lon: String(lon),
    });

    try {
      const response = await fetch(`/api/place-image?${params.toString()}`, {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("image request failed");
      const data = await response.json();
      const image = data && data.image ? data.image : null;
      placeImageCache.set(key, image);
      return image;
    } catch (_error) {
      placeImageCache.set(key, null);
      return null;
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

    let message;
    if (!state.pointA) {
      message =
        state.mode === "me"
          ? "Не удалось определить ваше местоположение. Нажмите на строку «Моё местоположение» или выберите режим «От точки A»."
          : "Сначала поставьте точку A: кликните по карте.";
    } else {
      message = "Теперь поставьте точку B: кликните по карте.";
    }

    showToast(message, "info");
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
    modeMe.disabled = busy;
    modeManual.disabled = busy;
    pointARow.disabled = busy;
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
    updatePointsUI();
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
    if (state.mode === "me" || !(state.pointA && state.pointB) || state.busy) return;
    const oldA = state.pointA;
    state.pointA = state.pointB;
    state.pointB = oldA;
    afterPointsChanged();
    showToast("Точки A и B поменяны местами.", "success");
  }

  function resetAll() {
    if (state.busy) return;
    if (state.mode === "me") {
      state.pointA = state.userLocation ? normalizePoint(state.userLocation) : null;
      state.pointB = null;
    } else {
      state.pointA = null;
      state.pointB = null;
    }

    clearDerivedForPoints();
    renderPoints();
    drawPreview(false);
    updatePointsUI();
    updatePeek();
    saveNow();
    syncPoints({ point_a: state.pointA, point_b: state.pointB });
    map.closePopup();
    if (isMobile()) setSheet(false);

    if (state.mode === "me" && !state.userLocation) {
      detectUserLocation({ setAsA: true, center: true, silent: false });
    }

    showToast(
      state.mode === "me"
        ? "Точка B сброшена. Кликните по карте, чтобы выбрать новый финиш."
        : "Маршрут сброшен. Кликните по карте — новая точка A.",
      "info"
    );
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

  // ------------------------------------------------------------
  // События
  // ------------------------------------------------------------

  map.on("click", (event) => {
    if (state.busy || nav.active) return;

    const point = {
      lat: roundCoord(event.latlng.lat),
      lon: roundCoord(event.latlng.lng),
    };

    if (state.mode === "me") {
      // В режиме «От меня» точка A — GPS, клик всегда задаёт/меняет B.
      state.pointB = point;
    } else if (!state.pointA || state.pointB) {
      // Ручной режим: первый клик — A, второй — B, третий — новый маршрут.
      state.pointA = point;
      state.pointB = null;
    } else {
      state.pointB = point;
    }

    afterPointsChanged();
    if (isMobile()) setSheet(false);
  });

  map.on("moveend", saveSoon);
  map.on("dragstart", () => {
    if (nav.active) {
      nav.follow = false;
      followBtn.hidden = false;
    }
  });

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

  pointARow.addEventListener("click", () => {
    if (state.mode === "me") {
      if (nav.active) {
        showToast("Сначала завершите навигацию.", "info");
        return;
      }
      detectUserLocation({ setAsA: true, center: true, silent: false });
      return;
    }
    focusPoint(state.pointA);
  });
  pointBRow.addEventListener("click", () => focusPoint(state.pointB));
  modeMe.addEventListener("click", () => setMode("me"));
  modeManual.addEventListener("click", () => setMode("manual"));
  swapBtn.addEventListener("click", swapPoints);
  resetBtn.addEventListener("click", resetAll);

  catsAll.addEventListener("click", () => setAllCategories(true));
  catsNone.addEventListener("click", () => setAllCategories(false));
  categoriesEl.addEventListener("change", onCategoriesChanged);

  searchBtn.addEventListener("click", () => doSearch());
  routeBtn.addEventListener("click", () => doRoute());
  retryLive.addEventListener("click", () => doSearch({ forceLive: true, fit: false }));

  navStartBtn.addEventListener("click", startNavigation);
  navStartFab.addEventListener("click", startNavigation);
  navStopBtn.addEventListener("click", () => stopNavigation());
  navVoiceBtn.addEventListener("click", () => {
    nav.voice = !nav.voice;
    updateVoiceButton();
    if (!nav.voice) {
      try {
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      } catch (_error) {
        /* ignore */
      }
    }
  });
  followBtn.addEventListener("click", () => {
    nav.follow = true;
    followBtn.hidden = true;
    if (nav.lastPos) {
      map.setView(nav.lastPos, Math.max(map.getZoom(), 17), { animate: false });
    }
  });

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
    if (document.hidden) {
      saveNow();
      releaseWakeLock();
    } else if (nav.active && !nav.arrived) {
      requestWakeLock();
    }
  });

  window.addEventListener("pagehide", () => {
    if (nav.active) stopNavigation({ silent: true });
    saveNow();
  });

  // ------------------------------------------------------------
  // Старт
  // ------------------------------------------------------------

  restoreSettings();

  sliderControls.forEach(setupSliderControl);

  updateVoiceButton();
  updateNavStartButtons();

  const debugParams = new URLSearchParams(window.location.search);
  if (debugParams.has("debug")) {
    if (debugParams.has("mockgeo") && "geolocation" in navigator) {
      const [mockLat, mockLon] = (debugParams.get("mockgeo") || "")
        .split(",")
        .map((value) => Number(value));
      if (Number.isFinite(mockLat) && Number.isFinite(mockLon)) {
        try {
          navigator.geolocation.getCurrentPosition = (success) => {
            success({
              coords: {
                latitude: mockLat,
                longitude: mockLon,
                accuracy: 8,
                heading: 0,
                speed: 0,
              },
            });
          };
        } catch (_error) {
          /* ignore debug mock errors */
        }
      }
    }
    window.__loopDebug = { state, nav, map, detectUserLocation, setMode };
  }

  applyTheme(currentTheme, { persist: false });
  renderPoints();
  drawPreview(false);
  updateSourcePill();
  updateCounts();
  updatePointsUI();
  updatePeek();
  setSheet(false);

  if (state.mode === "me") {
    detectUserLocation({ setAsA: true, center: true, silent: false });
  } else {
    detectUserLocation({
      setAsA: false,
      center: !state.pointA && !state.pointB,
      silent: true,
    });
  }
})();
