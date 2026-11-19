/**
 * 벚꽃 개화 로드트립 — 심플·직관 웹서비스 (PDF 8~13페이지 구현)
 * - 백그라운드에서 verified_data.js 및 CherryHydrology 엔진(GDD + 물수지 ΔS) 자동 구동
 * - 무인증 공개 API만 사용: Open-Meteo, OSRM, OpenStreetMap/Esri
 */

(function () {
  "use strict";

  const H = window.CherryHydrology;
  const DATA = window.VERIFIED_CHERRY_DATA;

  if (!DATA || !H) {
    console.error("VERIFIED_CHERRY_DATA 또는 CherryHydrology가 로드되지 않았습니다.");
    return;
  }

  H.ensureMultimodalRouting(DATA);

  const KOREA_BOUNDS = [
    [33.15, 126.2],
    [38.05, 129.45],
  ];

  const SLIDER_DAYS_COUNT = 51;

  const STORAGE_KEYS = {
    WATCHLIST: "cherry_watchlist_v1",
    REPORTS: "cherry_reports_v1",
  };

  function getDefaultYear() {
    return Number(DATA.defaultYear || (DATA.dailyByYear?.["2027"] ? 2027 : 2026));
  }

  function getSliderStartDate() {
    return `${state.activeYear}-03-01`;
  }

  function replaceIsoYear(isoDate, targetYear) {
    if (!isoDate || isoDate.length < 10) return `${targetYear}-03-29`;
    return `${targetYear}-${isoDate.slice(5)}`;
  }

  function loadWatchlist() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.WATCHLIST));
      if (Array.isArray(saved) && saved.length > 0) return saved;
    } catch (_) {}
    return ["108", "143", "155", "283"];
  }

  function loadReports() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.REPORTS));
      if (Array.isArray(saved)) return saved.filter((r) => r.id !== "seed-1");
    } catch (_) {}
    return [];
  }

  const initialYear = getDefaultYear();

  const state = {
    activeView: "map",
    activeYear: initialYear,
    targetDate: `${initialYear}-03-29`,
    selectedStationId: "155",
    watchlistIds: loadWatchlist(),
    reports: loadReports(),
    extraNotifications: [],
    currentEvaluations: [],
    currentTrip: null,
    isAnimatingNorth: false,
    animTimer: null,
  };

  const maps = {
    main: null,
    trip: null,
    mainMarkers: {},
    tripMarkersLayer: null,
    tripRouteLayer: null,
  };

  const osrmRouteCache = new Map();
  let tripDrawSeq = 0;

  function buildBezierArc(fromLatLng, toLatLng, curveRatio = 0.14, steps = 28) {
    const [lat1, lon1] = fromLatLng;
    const [lat2, lon2] = toLatLng;
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const midLat = (lat1 + lat2) / 2;
    const midLon = (lon1 + lon2) / 2;

    let nx = -dLon;
    let ny = dLat;
    if (nx < 0 || (Math.abs(nx) < 0.05 && ny < 0)) {
      nx = -nx;
      ny = -ny;
    }

    const ctrlLat = midLat + nx * curveRatio;
    const ctrlLon = midLon + ny * curveRatio;
    const points = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const mt = 1 - t;
      points.push([
        mt * mt * lat1 + 2 * mt * t * ctrlLat + t * t * lat2,
        mt * mt * lon1 + 2 * mt * t * ctrlLon + t * t * lon2,
      ]);
    }
    const midPoint = [
      0.25 * lat1 + 0.5 * ctrlLat + 0.25 * lat2,
      0.25 * lon1 + 0.5 * ctrlLon + 0.25 * lon2,
    ];
    return { points, midPoint };
  }

  async function fetchLegRoadCoords(fromSt, toSt) {
    const key = `${fromSt.id}-${toSt.id}`;
    if (osrmRouteCache.has(key)) return osrmRouteCache.get(key);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fromSt.lon},${fromSt.lat};${toSt.lon},${toSt.lat}?overview=full&geometries=geojson`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json.routes?.[0]?.geometry?.coordinates) {
          const coords = json.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
          osrmRouteCache.set(key, coords);
          return coords;
        }
      }
    } catch (_) {}
    return null;
  }

  function showToast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove("show"), 3000);
  }

  function formatFullKoreanDate(isoDate) {
    const [y, m, d] = isoDate.split("-");
    return `${y}년 ${Number(m)}월 ${Number(d)}일`;
  }

  function formatMonthDayKorean(isoDate) {
    const [, m, d] = isoDate.split("-");
    return `${Number(m)}월 ${Number(d)}일`;
  }

  function sliderIndexToDate(idx) {
    return H.addDaysIso(getSliderStartDate(), Number(idx));
  }

  function dateToSliderIndex(isoDate) {
    const diff = H.diffDaysIso(getSliderStartDate(), isoDate);
    return Math.max(0, Math.min(SLIDER_DAYS_COUNT - 1, diff));
  }

  function getReportsCalibrationMap() {
    const map = {};
    const prefix = `${state.activeYear}-`;
    for (const r of state.reports) {
      if (r.date && !r.date.startsWith(prefix)) continue;
      if (!map[r.stationId]) {
        map[r.stationId] = { offsetDays: r.offsetDays || 0, count: 1 };
      } else {
        map[r.stationId].offsetDays += r.offsetDays || 0;
        map[r.stationId].count += 1;
      }
    }
    for (const sid of Object.keys(map)) {
      map[sid].offsetDays = Math.max(-3, Math.min(3, Math.round(map[sid].offsetDays / map[sid].count)));
    }
    return map;
  }

  function recalculateEvaluations() {
    state.currentEvaluations = H.evaluateAllStations(DATA, state.targetDate, {
      year: state.activeYear,
      tBase: 1.2,
      tempShift: 0,
      precipScalePct: 0,
      waterBalanceEnabled: true,
      useLiteratureThreshold: false,
      reportsByStation: getReportsCalibrationMap(),
    });
  }

  function getSelectedEval() {
    return (
      state.currentEvaluations.find((e) => e.station.id === state.selectedStationId) ||
      state.currentEvaluations[0]
    );
  }

  // ================= Leaflet Maps =================
  function createTileLayerWithFallback() {
    // file:// 직접 실행 및 GitHub Pages(https://) 모두에서 차단 없이 동작하는 무인증 공개 타일 사용
    const primary = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Tiles &copy; Esri",
        maxZoom: 18,
      }
    );
    primary.on("tileerror", function onErr() {
      if (primary._switchedFallback || window.location.protocol === "file:") return;
      primary._switchedFallback = true;
      primary.setUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    });
    return primary;
  }

  function initMaps() {
    maps.main = L.map("mainMap", {
      center: [35.65, 127.75],
      zoom: 7,
      zoomControl: true,
    });
    createTileLayerWithFallback().addTo(maps.main);
    maps.main.fitBounds(KOREA_BOUNDS, { padding: [16, 16] });

    maps.trip = L.map("tripMap", {
      center: [35.85, 127.75],
      zoom: 7,
      zoomControl: true,
    });
    createTileLayerWithFallback().addTo(maps.trip);
    maps.tripMarkersLayer = L.layerGroup().addTo(maps.trip);
    maps.tripRouteLayer = L.layerGroup().addTo(maps.trip);
  }

  function makePinIcon(ev, isSelected, isAlerted) {
    const st = ev.station;
    const color = isAlerted ? "#D94358" : ev.stage.color;
    // PDF 8p·9p처럼 직관적인 "지역 · 상태" 표기
    const stageShort = ev.stage.label.replace(" ", "");
    const statusText = isAlerted ? "⚠호우특보" : stageShort;
    const html = `
      <div class="cherry-pin">
        <div class="cherry-dot ${isSelected ? "selected" : ""}" style="background:${color};"></div>
        <div class="cherry-label">${st.name} · <small>${statusText}</small></div>
      </div>
    `;
    return L.divIcon({
      className: "cherry-pin-wrap",
      html,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function syncMapMarkers() {
    const hazards = H.evaluateWeatherHazards(DATA, state.targetDate);
    const activeAlertSet = new Set(hazards.filter((h) => h.activeAlert).map((h) => h.station.id));

    for (const ev of state.currentEvaluations) {
      const sid = ev.station.id;
      const isSelected = sid === state.selectedStationId;
      const isAlerted = activeAlertSet.has(sid);
      const icon = makePinIcon(ev, isSelected, isAlerted);

      if (!maps.mainMarkers[sid]) {
        const marker = L.marker([ev.station.lat, ev.station.lon], { icon }).addTo(maps.main);
        marker.on("click", () => selectStation(sid, true));
        maps.mainMarkers[sid] = marker;
      } else {
        maps.mainMarkers[sid].setIcon(icon);
      }
    }
  }

  async function drawTripRouteOnTripMap(trip, shouldFitBounds = false) {
    const mySeq = ++tripDrawSeq;
    maps.tripRouteLayer.clearLayers();
    maps.tripMarkersLayer.clearLayers();

    if (!trip || !trip.itinerary.length) return;

    // 자동차·버스 구간만 OSRM 실제 도로 폴리라인을 구간별로 병렬 조회
    const roadGeoms = await Promise.all(
      trip.itinerary.map(async (day) => {
        const isRoadLeg = day.leg?.modeType === "car" || day.leg?.modeType === "bus";
        const sameRegion = day.fromStation.isIsland === day.toStation.isIsland;
        if (!isRoadLeg || !sameRegion || day.fromStation.id === day.toStation.id) {
          return null;
        }
        return fetchLegRoadCoords(day.fromStation, day.toStation);
      })
    );

    if (mySeq !== tripDrawSeq) return;

    maps.tripRouteLayer.clearLayers();
    maps.tripMarkersLayer.clearLayers();

    const boundsPoints = [[trip.originStation.lat, trip.originStation.lon]];

    trip.itinerary.forEach((day, idx) => {
      const fromSt = day.fromStation;
      const toSt = day.toStation;
      boundsPoints.push([toSt.lat, toSt.lon]);
      if (fromSt.id === toSt.id) return;

      const pA = [fromSt.lat, fromSt.lon];
      const pB = [toSt.lat, toSt.lon];
      const modeType = day.leg?.modeType || "car";

      if (modeType === "flight") {
        const { points, midPoint } = buildBezierArc(pA, pB, 0.26, 28);
        L.polyline(points, {
          color: "#B85D79",
          weight: 3.5,
          opacity: 0.92,
          dashArray: "7 7",
        }).addTo(maps.tripRouteLayer);

        L.marker(midPoint, {
          interactive: false,
          icon: L.divIcon({
            className: "cherry-pin-wrap",
            html: `<div class="flight-mid-badge">✈️ ${H.formatDurationMinutes(day.leg.minutes)}</div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        }).addTo(maps.tripRouteLayer);

        boundsPoints.push(midPoint);
      } else if (modeType === "rail") {
        const { points } = buildBezierArc(pA, pB, 0.05, 18);
        L.polyline(points, {
          color: "#3D6B82",
          weight: 4,
          opacity: 0.9,
          dashArray: "5 7",
        }).addTo(maps.tripRouteLayer);
      } else {
        const osrmCoords = roadGeoms[idx];
        const polyPts = osrmCoords && osrmCoords.length > 1 ? osrmCoords : [pA, pB];
        const isBus = modeType === "bus";
        L.polyline(polyPts, {
          color: isBus ? "#2D6A4F" : "#1D352B",
          weight: osrmCoords ? (isBus ? 4.2 : 4.5) : 3.5,
          opacity: 0.88,
          dashArray: isBus ? "10 6" : osrmCoords ? null : "6 6",
        }).addTo(maps.tripRouteLayer);

        if (osrmCoords && osrmCoords.length > 2) {
          boundsPoints.push(osrmCoords[Math.floor(osrmCoords.length / 2)]);
        }
      }
    });

    const originIcon = L.divIcon({
      className: "cherry-pin-wrap",
      html: `<div class="cherry-pin"><div class="cherry-dot" style="background:#1D352B;"></div><div class="cherry-label">출발 · ${trip.originStation.name}</div></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker([trip.originStation.lat, trip.originStation.lon], { icon: originIcon }).addTo(maps.tripMarkersLayer);

    trip.itinerary.forEach((day) => {
      const stopIcon = L.divIcon({
        className: "cherry-pin-wrap",
        html: `<div class="cherry-pin"><div class="cherry-dot selected" style="background:${day.stage.color};"></div><div class="cherry-label">${day.dayNumber}. ${day.toStation.name} · <small>${day.stage.label}</small></div></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([day.toStation.lat, day.toStation.lon], { icon: stopIcon }).addTo(maps.tripMarkersLayer);
    });

    document.getElementById("tripMapSubtitle").textContent = `${trip.originStation.name} 출발 ${trip.totalDays}일 코스 · 총 이동 ${H.formatDurationMinutes(trip.totalMinutes)} (${trip.totalKm}km)`;

    if (shouldFitBounds || state.activeView === "trip") {
      if (boundsPoints.length <= 1) {
        maps.trip.setView(boundsPoints[0], 9);
      } else {
        maps.trip.fitBounds(L.latLngBounds(boundsPoints).pad(0.22));
      }
    }
  }

  function selectStation(stationId, panMap = true) {
    state.selectedStationId = stationId;
    const ev = getSelectedEval();
    if (!ev) return;

    syncMapMarkers();
    renderSelectedCityCard();

    if (panMap && maps.main) {
      maps.main.panTo([ev.station.lat, ev.station.lon], { animate: true });
    }
  }

  // ================= VIEW 1: MAP =================
  function renderDateUI() {
    document.getElementById("datePickerInput").value = state.targetDate;
    document.getElementById("alertDatePicker").value = state.targetDate;
    document.getElementById("dateSlider").value = String(dateToSliderIndex(state.targetDate));
    document.getElementById("sliderDateLabel").textContent = `${state.targetDate} (${H.formatKoreanDate(state.targetDate).slice(-2, -1)})`;
    const yearBadgeText = state.activeYear >= 2027 ? `${state.activeYear} 예측` : `${state.activeYear} 실측`;
    document.getElementById("mapSubDate").textContent = `${formatFullKoreanDate(state.targetDate)} (${yearBadgeText})`;
    const originId = document.getElementById("tripOrigin")?.value || "108";
    const originName = DATA.stations.find((s) => s.id === originId)?.name || "서울";
    document.getElementById("mapSubOrigin").textContent = `${originName} 출발`;

    document.querySelectorAll("#yearToggleBar .year-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.year) === state.activeYear);
    });
    const tripYearBtn = document.getElementById("tripYearBadge");
    if (tripYearBtn) {
      tripYearBtn.textContent = `${yearBadgeText} 기준 ⇄`;
    }
  }

  function renderStageGuideCard() {
    const groups = { scheduled: [], opening: [], full: [], ended: [] };
    for (const ev of state.currentEvaluations) {
      groups[ev.stage.key]?.push(ev.station.name);
    }

    Object.keys(groups).forEach((key) => {
      const el = document.getElementById(`stageList-${key}`);
      el.textContent = groups[key].length ? groups[key].join(" · ") : "해당 지역 없음";
    });
  }

  function renderRecommendBanner() {
    const originId = document.getElementById("tripOrigin")?.value || "108";
    const transportMode = document.getElementById("tripTransport")?.value || "car";
    const originStation = DATA.stations.find((s) => s.id === originId);
    // 출발지가 제주일 때는 육지·도내 모두 공정 평가, 육지 출발일 때는 육지 우선
    const ranked = [...state.currentEvaluations].sort((a, b) => {
      const stageScore = (e) => (e.stage.key === "full" ? 30 : e.stage.key === "opening" ? 20 : 0);
      const festA = a.station.festival && state.targetDate >= a.station.festival.start && state.targetDate <= a.station.festival.end ? 8 : 0;
      const festB = b.station.festival && state.targetDate >= b.station.festival.start && state.targetDate <= b.station.festival.end ? 8 : 0;
      const mainlandA = originStation?.isIsland || !a.station.isIsland ? 4 : 0;
      const mainlandB = originStation?.isIsland || !b.station.isIsland ? 4 : 0;
      return stageScore(b) + festB + mainlandB - (stageScore(a) + festA + mainlandA);
    });
    const best = ranked[0];
    if (!best) return;

    const leg = H.getTravelLeg(
      DATA.routingMatrix,
      originId,
      best.station.id,
      transportMode,
      DATA.stations
    );
    const daysToOpen = H.diffDaysIso(state.targetDate, best.predictedOpenDate);
    const ddayText =
      best.stage.key === "full"
        ? "만개!"
        : best.stage.key === "opening"
        ? "개화중"
        : daysToOpen > 0
        ? `D-${daysToOpen}`
        : "추천";

    const festName = best.station.festival?.name || best.station.spotName;
    const travelLabel =
      best.station.id === originId
        ? "출발지 인근"
        : `${leg.modeLabel} 약 ${H.formatDurationMinutes(leg.minutes)}`;

    document.getElementById("recommendDday").textContent = ddayText;
    document.getElementById("recommendTitle").textContent = `이번 기준일 추천 · ${best.station.name}`;
    document.getElementById("recommendSub").textContent = `${festName} (${best.stage.label}) · ${travelLabel}`;
  }

  function renderSelectedCityCard() {
    const ev = getSelectedEval();
    if (!ev) return;
    const st = ev.station;
    const isWatched = state.watchlistIds.includes(st.id);

    document.getElementById("selectedCityName").textContent = st.name;
    document.getElementById("selectedCitySpot").textContent = `${st.spotName} (${st.region})`;

    const stageEl = document.getElementById("selectedCityStage");
    stageEl.textContent = ev.stage.label;
    stageEl.style.background = ev.stage.bgTint;
    stageEl.style.color = ev.stage.textColor;

    document.getElementById("selectedCityOpenDate").textContent = formatMonthDayKorean(ev.predictedOpenDate);
    document.getElementById("selectedCityPeakDate").textContent = `${formatMonthDayKorean(ev.predictedFullDate)}경`;
    const endDateEl = document.getElementById("selectedCityEndDate");
    if (endDateEl) {
      endDateEl.textContent = `${formatMonthDayKorean(ev.predictedEndDate)}경`;
    }

    const rainNoteEl = document.getElementById("selectedCityRainNote");
    if (rainNoteEl) {
      if (ev.rainShortenedDays > 0 && ev.petalFallRainEvents?.length) {
        const peakRain = [...ev.petalFallRainEvents].sort((a, b) => b.precip - a.precip)[0];
        const srcLabel = state.activeYear >= 2027 ? "예보·실측 강수" : "실측 강수";
        rainNoteEl.style.display = "block";
        rainNoteEl.innerHTML = `🌧️ <strong>${srcLabel}(${H.formatShortMonthDay(peakRain.date)} ${peakRain.precip.toFixed(1)}mm)</strong> 반영 · 낙화 <strong>${ev.rainShortenedDays}일</strong> 앞당겨짐 <span style="opacity:0.82;">(무강수 기준 ${formatMonthDayKorean(ev.predictedEndDateNoRain)} → ${formatMonthDayKorean(ev.predictedEndDate)})</span>`;
      } else {
        rainNoteEl.style.display = "none";
        rainNoteEl.innerHTML = "";
      }
    }

    const vsNormStr =
      ev.daysVsNormal === 0
        ? "평년 개화일과 동일합니다"
        : ev.daysVsNormal < 0
        ? `평년(${formatMonthDayKorean(ev.normalBloomDate)})보다 ${Math.abs(ev.daysVsNormal)}일 빠르게 개화합니다`
        : `평년(${formatMonthDayKorean(ev.normalBloomDate)})보다 ${ev.daysVsNormal}일 늦게 개화합니다`;
    document.getElementById("selectedCityVsNormal").textContent = vsNormStr;

    const metaBox = document.getElementById("selectedCityForecastMeta");
    const fest = st.festival;
    if (state.activeYear >= 2027 && ev.forecastMeta) {
      const fm = ev.forecastMeta;
      const diff26 = ev.daysVs2026;
      const vs26Text =
        diff26 === 0
          ? "전년(2026) 실측과 동일"
          : diff26 < 0
          ? `전년(${formatMonthDayKorean(ev.obsBloom2026Date)}) 대비 ${Math.abs(diff26)}일 빠름`
          : `전년(${formatMonthDayKorean(ev.obsBloom2026Date)}) 대비 ${diff26}일 늦음`;
      const trendSign = fm.warmingPerDecadeC >= 0 ? "+" : "";
      const basisBadge =
        fm.sourceMode === "live_hybrid"
          ? `실측 ${fm.observedDays}일 + 16일 수치예보 결합 (GDD · 물수지 ΔS)`
          : `2023~2026 다년 보정 · 10년 기상 앙상블(GDD·물수지 ΔS) + 온난화(${trendSign}${fm.warmingPerDecadeC}°C/10년)`;

      metaBox.style.display = "block";
      metaBox.innerHTML = `
        <div><strong>예측 변동 범위 (10년 앙상블 IQR):</strong> ${formatMonthDayKorean(fm.p25OpenDate)} ~ ${formatMonthDayKorean(fm.p75OpenDate)}</div>
        <div><strong>전년(2026) 실측 비교:</strong> ${vs26Text}</div>
        <span class="forecast-meta-badge">${basisBadge}</span>
      `;

      document.getElementById("selectedCityFestival").innerHTML = `
        <strong>🎪 지역 벚꽃축제:</strong> ${fest.name}<br/>
        <span style="color:var(--text-muted);">2027 일정 발표 전 (전년 ${H.formatShortMonthDay(fest.start)}~${H.formatShortMonthDay(fest.end)} 참고 · ${fest.location})</span>
      `;
    } else {
      metaBox.style.display = "none";
      metaBox.innerHTML = "";
      document.getElementById("selectedCityFestival").innerHTML = `
        <strong>🎪 지역 벚꽃축제:</strong> ${fest.name}<br/>
        <span style="color:var(--text-muted);">${fest.start} ~ ${fest.end} · ${fest.location}</span>
      `;
    }

    const watchBtn = document.getElementById("btnWatchToggle");
    watchBtn.textContent = isWatched ? "★ 관심 지역 등록됨" : "🔔 관심 지역 등록";
  }

  // ================= VIEW 2: ROADTRIP =================
  function populateSelects() {
    const originSel = document.getElementById("tripOrigin");
    const reportSel = document.getElementById("reportStation");

    const html = DATA.stations.map((s) => `<option value="${s.id}">${s.name} (${s.region})</option>`).join("");
    originSel.innerHTML = html;
    originSel.value = "108";

    reportSel.innerHTML = html;
    reportSel.value = "133";
  }

  function renderTripResult(trip, shouldFitBounds = false) {
    if (!trip) return;
    const nights = Math.max(0, trip.totalDays - 1);
    const stayLabel = nights === 0 ? "당일치기" : `${nights}박 ${trip.totalDays}일`;
    document.getElementById("tripHeaderSummary").textContent = `${H.formatKoreanDate(trip.startDate)} ~ ${H.formatKoreanDate(trip.endDate)} · ${stayLabel} · 총 이동 ${H.formatDurationMinutes(trip.totalMinutes)} (${trip.totalKm}km)`;

    const listEl = document.getElementById("tripItineraryList");
    if (!trip.itinerary.length) {
      listEl.innerHTML = `<div style="padding:12px; color:var(--text-muted);">선택하신 조건에 맞는 일정을 생성할 수 없습니다.</div>`;
      maps.tripRouteLayer?.clearLayers();
      maps.tripMarkersLayer?.clearLayers();
      return;
    }

    listEl.innerHTML = trip.itinerary
      .map((day, idx) => {
        const circleClass = idx === 0 ? "day1" : idx === 1 ? "day2" : "";
        const festBadge = day.isFestivalActive
          ? `<span class="stage-pill" style="background:var(--pink-tint); color:var(--pink-full); margin-top:6px;">🎪 ${day.festival.name}${day.isFestivalEstimated ? " (예상 시기)" : ""}</span>`
          : `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:5px;">추천 명소: ${day.toStation.spotName}</div>`;

        const autoChip = day.leg.autoReason
          ? `<span class="transport-note">${day.leg.autoReason}</span>`
          : "";

        const detailRow = day.leg.detail
          ? `<div class="leg-detail-row">${day.leg.detail}</div>`
          : "";

        let modeControls = "";
        if (day.fromStation.id !== day.toStation.id && day.availableModes?.length) {
          if (day.availableModes.length === 1 && day.fromStation.isIsland !== day.toStation.isIsland) {
            modeControls = `<div class="leg-mode-bar"><span class="leg-mode-fixed">✈️ 해상 구간 · 항공 전용 (자동차 불가)</span></div>`;
          } else if (day.availableModes.length > 1) {
            const buttonsHtml = day.availableModes
              .map((m) => {
                const isActive = m.modeType === day.leg.modeType;
                return `<button type="button" class="leg-mode-btn ${isActive ? `active mode-${m.modeType}` : ""}" data-day-index="${idx}" data-mode="${m.modeType}">${m.chipLabel}</button>`;
              })
              .join("");
            modeControls = `<div class="leg-mode-bar">${buttonsHtml}</div>`;
          }
        }

        return `
          <div class="day-card" data-station="${day.toStation.id}">
            <div class="step-circle ${circleClass}">${day.dayNumber}</div>
            <div>
              <div style="font-size:0.74rem; font-weight:700; color:var(--text-muted);">DAY ${day.dayNumber} · ${day.dateLabel}</div>
              <div style="font-size:1.02rem; font-weight:800; color:var(--green-deep); margin:2px 0 4px;">
                ${day.fromStation.name} → ${day.toStation.name}
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span style="font-size:0.79rem; font-weight:600; color:var(--text-main);">
                  ${day.leg.modeLabel} ${H.formatDurationMinutes(day.leg.minutes)}
                </span>
                <span class="stage-pill" style="background:${day.stage.bgTint}; color:${day.stage.textColor};">
                  ${day.stage.label}
                </span>
                ${autoChip}
              </div>
              ${detailRow}
              ${modeControls}
              ${festBadge}
            </div>
          </div>
        `;
      })
      .join("");

    listEl.querySelectorAll(".day-card").forEach((card) => {
      card.addEventListener("click", () => {
        const st = DATA.stations.find((s) => s.id === card.dataset.station);
        if (st && maps.trip) {
          maps.trip.setView([st.lat, st.lon], 9, { animate: true });
        }
      });
    });

    listEl.querySelectorAll(".leg-mode-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const dayIdx = Number(btn.dataset.dayIndex);
        const modeType = btn.dataset.mode;
        H.updateTripLegMode(DATA, state.currentTrip, dayIdx, modeType);
        const updatedLeg = state.currentTrip.itinerary[dayIdx]?.leg;
        renderTripResult(state.currentTrip, false);
        if (updatedLeg) {
          showToast(`DAY ${dayIdx + 1} 이동수단을 ${updatedLeg.modeLabel}(으)로 변경했습니다.`);
        }
      });
    });

    drawTripRouteOnTripMap(trip, shouldFitBounds);
  }

  function buildAndRenderTrip(shouldNotify = false) {
    const originId = document.getElementById("tripOrigin").value;
    const startDate = document.getElementById("tripStartDate").value;
    const endDate = document.getElementById("tripEndDate").value;
    const transportMode = document.getElementById("tripTransport").value;
    const excludeHazard = document.getElementById("tripExcludeHazard").checked;
    const includeJeju = document.getElementById("tripIncludeJeju").checked;

    const trip = H.planRoadTrip(DATA, state.currentEvaluations, {
      originId,
      startDate,
      endDate: endDate < startDate ? startDate : endDate,
      transportMode,
      includeJeju,
      excludeHazard,
    });
    state.currentTrip = trip;

    renderTripResult(trip, shouldNotify);
    if (shouldNotify && trip.itinerary.length) {
      const nights = Math.max(0, trip.totalDays - 1);
      const stayLabel = nights === 0 ? "당일치기" : `${nights}박 ${trip.totalDays}일`;
      showToast(`${trip.originStation.name} 출발 ${stayLabel} 로드트립 추천이 완료되었습니다.`);
    }
  }

  // ================= VIEW 3: ALERTS & REPORTS =================
  function toggleWatchlist(stationId) {
    const idx = state.watchlistIds.indexOf(stationId);
    if (idx >= 0) {
      state.watchlistIds.splice(idx, 1);
      showToast("관심 지역 알림에서 해제되었습니다.");
    } else {
      state.watchlistIds.push(stationId);
      showToast("관심 지역으로 등록되었습니다. 개화 시작 시 알려드려요!");
    }
    localStorage.setItem(STORAGE_KEYS.WATCHLIST, JSON.stringify(state.watchlistIds));
    renderSelectedCityCard();
    renderAlertsView();
  }

  function renderAlertsView() {
    const hazards = H.evaluateWeatherHazards(DATA, state.targetDate);
    const activeAlerts = hazards.filter((h) => h.activeAlert);
    const hasLiveWeather = hazards.some((h) => h.isLiveWeather);

    document.getElementById("alertNavDot").classList.toggle("visible", activeAlerts.length > 0);

    const box = document.getElementById("hazardAlertBox");
    if (activeAlerts.length > 0) {
      const top = activeAlerts[0];
      const regionListText = activeAlerts
        .slice(0, 4)
        .map((h) => `${h.station.name}(${h.rainTodayMm}mm)`)
        .join(", ");
      const wamisRef = top.riverStatus
        ? ` · 인근 하천 ${top.riverStatus.river} ${top.riverStatus.name} 홍수주의보 기준 ${top.riverStatus.watchLevelM}m`
        : "";
      const sourceNote =
        top.dataType === "forecast16d"
          ? "Open-Meteo 16일 수치예보 일강수량 기준"
          : "Open-Meteo 실측 일강수량 데이터 기준";
      box.className = "hazard-box";
      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="flex:1;">
            <div style="font-size:0.96rem; font-weight:800; margin-bottom:5px;">
              ⚠️ 실측·예보 강수 집중 주의 · ${top.station.name} 외 ${Math.max(0, activeAlerts.length - 1)}곳
            </div>
            <div style="font-size:0.83rem; line-height:1.5; margin-bottom:6px;">
              ${formatFullKoreanDate(state.targetDate)} 강수량이 집중되었습니다: <strong>${regionListText}</strong>${wamisRef}. 여행 전 기상 확인 및 일정 조정을 고려하세요.
            </div>
            <div style="font-size:0.74rem; opacity:0.85;">${sourceNote}</div>
          </div>
          <button type="button" class="btn-pink" id="btnRerouteSafe">
            강수 지역 피해서 일정 다시 짜기 →
          </button>
        </div>
      `;

      document.getElementById("btnRerouteSafe").addEventListener("click", () => {
        const maxLimit = `${state.activeYear}-04-20`;
        document.getElementById("tripExcludeHazard").checked = true;
        document.getElementById("tripStartDate").value = state.targetDate;
        const endDateVal = H.addDaysIso(state.targetDate, 2);
        document.getElementById("tripEndDate").value = endDateVal <= maxLimit ? endDateVal : maxLimit;
        switchView("trip");
        buildAndRenderTrip(true);
      });
    } else if (!hasLiveWeather) {
      box.className = "hazard-box safe";
      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="flex:1;">
            <div style="font-size:0.93rem; font-weight:800; margin-bottom:5px;">📡 ${formatFullKoreanDate(state.targetDate)} · 2027 실시간 호우 특보 대기 중</div>
            <div style="font-size:0.82rem; line-height:1.5;">
              현재는 2027년 봄 도래 전으로 <strong>10년 기상 앙상블 + 온난화 추세</strong> 예측이 적용 중이며, 가짜 호우 경보는 표시하지 않습니다.<br/>
              출발 16일 전부터 Open-Meteo 수치예보·실측 강수(일 30mm / 48h 40mm 이상)가 자동 감지됩니다.
            </div>
          </div>
          <button type="button" class="btn-outline" id="btnTry2026Hazard">
            2026 실측 호우 경보(4/4) 체험하기 →
          </button>
        </div>
      `;
      document.getElementById("btnTry2026Hazard").addEventListener("click", () => {
        switchYear(2026, "2026-04-04");
        showToast("2026년 4월 4일 실측 강수 집중 주의 상태로 전환했습니다.");
      });
    } else {
      const maxRain = Math.max(0, ...hazards.map((h) => h.rainTodayMm));
      box.className = "hazard-box safe";
      box.innerHTML = `
        <div style="font-size:0.92rem; font-weight:800; margin-bottom:4px;">✅ ${formatFullKoreanDate(state.targetDate)} 호우·강수 특보 기준 지역 없음</div>
        <div style="font-size:0.82rem; line-height:1.45;">
          선택한 날짜 기준 전국 15개 관측지점 최대 일강수량은 <strong>${maxRain}mm</strong>로 안정적입니다.<br/>
          <span style="color:var(--text-muted); font-size:0.76rem;">※ 2026년 봄철 실제 큰 비가 온 날(예: 2026-04-04 남부·충청 32~67mm, 2026-04-09 경남·전남 37~54mm)을 선택하면 실측 강수 경보와 자동 우회를 확인할 수 있습니다.</span>
        </div>
      `;
    }

    // 실제 데이터 기반 최근 알림 피드 (가짜 고정 알림 제거)
    const watchedBlooming = state.currentEvaluations.filter(
      (e) => state.watchlistIds.includes(e.station.id) && (e.stage.key === "opening" || e.stage.key === "full")
    );

    const realFeed = [
      ...activeAlerts.slice(0, 2).map((h) => ({
        icon: "🌧️",
        title: `${h.station.name} 실측 강수 집중 (${h.rainTodayMm}mm)`,
        body: `48시간 누적 강수량 ${h.rain2DayMm}mm가 관측되어 방문 시 주의가 필요합니다`,
        time: formatMonthDayKorean(state.targetDate),
      })),
      ...state.extraNotifications,
      ...watchedBlooming.map((e) => ({
        icon: "🔆",
        title: `${e.station.name} ${e.stage.label}`,
        body: `관심 등록 지역이 '${e.stage.label}' 단계입니다 (${e.station.festival.name})`,
        time: `${H.formatShortMonthDay(e.predictedOpenDate)} 개화`,
      })),
    ];

    document.getElementById("alertFeedList").innerHTML = realFeed.length
      ? realFeed
          .slice(0, 6)
          .map(
            (n) => `
          <div class="notif-item">
            <div class="notif-icon">${n.icon}</div>
            <div style="flex:1;">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                <strong style="font-size:0.88rem; color:var(--green-deep);">${n.title}</strong>
                <span style="font-size:0.74rem; color:var(--text-muted);">${n.time}</span>
              </div>
              <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">${n.body}</div>
            </div>
          </div>
        `
          )
          .join("")
      : `<div style="padding:14px; background:var(--bg-ivory); border-radius:12px; font-size:0.82rem; color:var(--text-muted);">선택한 날짜(${formatFullKoreanDate(state.targetDate)}) 기준 개화 도달 또는 강수 집중 알림이 없습니다. 날짜를 이동하거나 관심 지역을 선택해 보세요.</div>`;

    // 관심 지역 칩 렌더링
    document.getElementById("watchChipContainer").innerHTML = DATA.stations
      .map((s) => {
        const active = state.watchlistIds.includes(s.id);
        return `<button type="button" class="watch-chip ${active ? "active" : ""}" data-id="${s.id}">${active ? "★ " : ""}${s.name}</button>`;
      })
      .join("");

    document.querySelectorAll("#watchChipContainer .watch-chip").forEach((chip) => {
      chip.addEventListener("click", () => toggleWatchlist(chip.dataset.id));
    });

    // 사용자 제보 목록
    document.getElementById("userReportsList").innerHTML = state.reports.length
      ? state.reports
          .slice(0, 4)
          .map(
            (r) => `
          <div style="padding:10px 12px; background:var(--bg-ivory); border-radius:11px; margin-bottom:8px; font-size:0.79rem;">
            <div style="display:flex; justify-content:space-between; font-weight:700; color:var(--green-deep);">
              <span>${r.stationName} · ${r.date} (${r.stageLabel})</span>
              <span style="color:var(--pink-full);">신뢰도 ${r.trustScore}점</span>
            </div>
            <div style="color:var(--text-muted); margin-top:2px;">${r.note}</div>
            ${
              r.photoDataUrl
                ? `<img src="${r.photoDataUrl}" alt="현장 제보 사진" style="margin-top:7px; width:100%; max-height:140px; object-fit:cover; border-radius:8px;" />`
                : ""
            }
          </div>
        `
          )
          .join("")
      : `<div style="padding:12px; background:var(--bg-ivory); border-radius:11px; font-size:0.79rem; color:var(--text-muted);">아직 등록된 현장 제보가 없습니다. 직접 보신 개화 상태를 첫 번째로 제보해 보세요.</div>`;
  }

  // ================= Live Open-Meteo Sync =================
  function buildSeriesFromDailyArrays(year, rawRows, fallbackSeries = []) {
    const startIso = `${year}-02-07`;
    const fallbackByDate = Object.fromEntries(fallbackSeries.map((r) => [r.date, r]));
    let cumGdd = 0,
      cumP = 0,
      cumEt = 0,
      cumQ = 0,
      cumDs = 0;

    return rawRows.map((row) => {
      const fb = fallbackByDate[row.date];
      const tMax = row.tMax ?? fb?.tMax ?? 0;
      const tMin = row.tMin ?? fb?.tMin ?? 0;
      const tMeanHL = Number(((tMax + tMin) / 2).toFixed(2));
      const tMean = Number((row.tMean ?? fb?.tMean ?? tMeanHL).toFixed(2));
      const precip = Number((row.precip ?? fb?.precip ?? 0).toFixed(2));
      const et0 = Number((row.et0 ?? fb?.et0 ?? 1.0).toFixed(2));
      const q = precip > 5 ? Number(((precip - 5) * 0.28).toFixed(2)) : 0;
      const deltaS = Number((precip - et0 - q).toFixed(2));

      let dailyGdd = 0;
      if (row.date >= startIso) {
        dailyGdd = Math.max(0, tMeanHL - 1.2);
        cumGdd = Number((cumGdd + dailyGdd).toFixed(2));
        cumP = Number((cumP + precip).toFixed(2));
        cumEt = Number((cumEt + et0).toFixed(2));
        cumQ = Number((cumQ + q).toFixed(2));
        cumDs = Number((cumDs + deltaS).toFixed(2));
      }

      return {
        date: row.date,
        dataType: row.dataType || (year <= 2026 ? "observed" : "climatology"),
        tMax,
        tMin,
        tMean,
        tMeanHL,
        precip,
        et0,
        runoffQ: q,
        deltaS,
        dailyGdd: Number(dailyGdd.toFixed(2)),
        cumGdd,
        cumPrecip: cumP,
        cumEt0: cumEt,
        cumRunoffQ: cumQ,
        cumDeltaS: cumDs,
      };
    });
  }

  async function syncLiveOpenMeteo() {
    const btn = document.getElementById("btnLiveSync");
    btn.disabled = true;
    btn.textContent = "⏳ 최신 기상 반영중...";

    try {
      const lats = DATA.stations.map((s) => s.lat).join(",");
      const lons = DATA.stations.map((s) => s.lon).join(",");
      const yr = state.activeYear;

      if (yr >= 2027) {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
          "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,et0_fao_evapotranspiration" +
          "&past_days=60&forecast_days=16&timezone=Asia%2FSeoul";
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const items = Array.isArray(json) ? json : [json];

        const winStart = `${yr}-02-01`;
        const winEnd = `${yr}-04-25`;
        const todayIso = new Date().toISOString().slice(0, 10);
        let overlapCount = 0;

        DATA.stations.forEach((st, idx) => {
          const daily = items[idx]?.daily;
          const baseSeries = DATA.dailyByYear?.[String(yr)]?.[st.id] || DATA.daily2027?.[st.id] || [];
          if (!daily || !baseSeries.length) return;

          const liveByDate = {};
          daily.time.forEach((dStr, i) => {
            if (dStr >= winStart && dStr <= winEnd && daily.temperature_2m_max[i] != null) {
              liveByDate[dStr] = {
                date: dStr,
                tMax: daily.temperature_2m_max[i],
                tMin: daily.temperature_2m_min[i],
                tMean: daily.temperature_2m_mean[i],
                precip: daily.precipitation_sum[i],
                et0: daily.et0_fao_evapotranspiration[i],
                dataType: dStr < todayIso ? "observed" : "forecast16d",
              };
            }
          });

          const localOverlap = Object.keys(liveByDate).length;
          if (localOverlap === 0) return;
          overlapCount = Math.max(overlapCount, localOverlap);

          const mergedRaw = baseSeries.map((r) => liveByDate[r.date] || r);
          const rebuilt = buildSeriesFromDailyArrays(yr, mergedRaw, baseSeries);
          if (!DATA.dailyByYear) DATA.dailyByYear = {};
          if (!DATA.dailyByYear[String(yr)]) DATA.dailyByYear[String(yr)] = {};
          DATA.dailyByYear[String(yr)][st.id] = rebuilt;
          if (yr === 2027) DATA.daily2027[st.id] = rebuilt;

          if (st.forecast2027Meta) {
            st.forecast2027Meta.observedDays = rebuilt.filter((r) => r.dataType === "observed").length;
            st.forecast2027Meta.forecast16dDays = rebuilt.filter((r) => r.dataType === "forecast16d").length;
            st.forecast2027Meta.climatologyDays = rebuilt.filter((r) => r.dataType === "climatology").length;
            st.forecast2027Meta.sourceMode = "live_hybrid";
          }
        });

        if (overlapCount === 0) {
          showToast(
            `${yr}년 10년 기상 앙상블·온난화 추세 예측이 적용 중입니다. ${yr}년 1월 중순부터 16일 수치예보가 자동 결합됩니다.`
          );
          return;
        }

        refreshAllViews();
        showToast(`${yr}년 최신 실측·16일 수치예보를 반영해 개화 예측을 갱신했습니다.`);
      } else {
        const url =
          `https://archive-api.open-meteo.com/v1/archive?latitude=${lats}&longitude=${lons}` +
          "&start_date=2026-02-01&end_date=2026-04-25" +
          "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,et0_fao_evapotranspiration" +
          "&timezone=Asia%2FSeoul";

        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const items = Array.isArray(json) ? json : [json];

        DATA.stations.forEach((st, idx) => {
          const daily = items[idx]?.daily;
          if (!daily) return;
          const rawRows = daily.time.map((dStr, i) => ({
            date: dStr,
            tMax: daily.temperature_2m_max[i],
            tMin: daily.temperature_2m_min[i],
            tMean: daily.temperature_2m_mean[i],
            precip: daily.precipitation_sum[i],
            et0: daily.et0_fao_evapotranspiration[i],
            dataType: "observed",
          }));
          const rebuilt = buildSeriesFromDailyArrays(2026, rawRows, DATA.daily2026[st.id] || []);
          DATA.daily2026[st.id] = rebuilt;
          if (DATA.dailyByYear) DATA.dailyByYear["2026"][st.id] = rebuilt;
        });

        refreshAllViews();
        showToast("2026년 실측 기온·강수 데이터를 다시 불러와 개화 계산을 갱신했습니다.");
      }
    } catch (_) {
      showToast("일시적인 통신 오류로 내장 검증 데이터를 유지합니다.");
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ 최신 기상 반영";
    }
  }

  // ================= Navigation & Updates =================
  function setTargetDate(newDate) {
    state.targetDate = newDate;
    recalculateEvaluations();
    renderDateUI();
    syncMapMarkers();
    renderStageGuideCard();
    renderRecommendBanner();
    renderSelectedCityCard();
    renderAlertsView();
  }

  function switchView(viewName) {
    state.activeView = viewName;
    if (window.location.hash !== `#${viewName}`) {
      history.replaceState(null, "", `#${viewName}`);
    }
    document.querySelectorAll(".web-nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === viewName));
    document.querySelectorAll(".web-view").forEach((v) => v.classList.toggle("active", v.id === `view-${viewName}`));

    if (viewName === "map") {
      setTimeout(() => maps.main?.invalidateSize(), 60);
    } else if (viewName === "trip") {
      setTimeout(() => {
        maps.trip?.invalidateSize();
        drawTripRouteOnTripMap(state.currentTrip, true);
      }, 60);
    }
  }

  function syncDateInputBounds(inputEl, minIso, maxIso, targetVal) {
    if (!inputEl) return;
    inputEl.min = "";
    inputEl.max = "";
    const clamped = targetVal < minIso ? minIso : targetVal > maxIso ? maxIso : targetVal;
    inputEl.value = clamped;
    inputEl.min = minIso;
    inputEl.max = maxIso;
  }

  function switchYear(newYear, optionalTargetDate = null) {
    const y = Number(newYear);
    if (state.isAnimatingNorth) {
      toggleNorthAnimation();
    }
    state.activeYear = y;
    const desiredTarget = optionalTargetDate || replaceIsoYear(state.targetDate, y);
    const minDate = `${y}-03-01`;
    const maxDate = `${y}-04-20`;
    state.targetDate = desiredTarget < minDate ? minDate : desiredTarget > maxDate ? maxDate : desiredTarget;

    syncDateInputBounds(document.getElementById("datePickerInput"), minDate, maxDate, state.targetDate);
    syncDateInputBounds(document.getElementById("alertDatePicker"), minDate, maxDate, state.targetDate);

    const reportEl = document.getElementById("reportDate");
    syncDateInputBounds(reportEl, minDate, maxDate, replaceIsoYear(reportEl?.value, y));

    const tripMin = `${y}-03-15`;
    const tripMax = `${y}-04-20`;
    const startEl = document.getElementById("tripStartDate");
    const endEl = document.getElementById("tripEndDate");
    syncDateInputBounds(startEl, tripMin, tripMax, replaceIsoYear(startEl?.value || `${y}-04-03`, y));
    syncDateInputBounds(endEl, tripMin, tripMax, replaceIsoYear(endEl?.value || `${y}-04-05`, y));

    refreshAllViews();
  }

  function toggleNorthAnimation() {
    const btn = document.getElementById("btnAnimateNorth");
    if (state.isAnimatingNorth) {
      clearInterval(state.animTimer);
      state.isAnimatingNorth = false;
      btn.textContent = "▶ 매주 북상 보기";
      return;
    }

    const animStart = `${state.activeYear}-03-18`;
    const animEnd = `${state.activeYear}-04-15`;
    state.isAnimatingNorth = true;
    btn.textContent = "⏸ 정지";
    let stepDate = animStart;
    setTargetDate(stepDate);

    state.animTimer = setInterval(() => {
      stepDate = H.addDaysIso(stepDate, 1);
      if (stepDate > animEnd) stepDate = animStart;
      setTargetDate(stepDate);
    }, 350);
  }

  function refreshAllViews() {
    recalculateEvaluations();
    renderDateUI();
    syncMapMarkers();
    renderStageGuideCard();
    renderRecommendBanner();
    renderSelectedCityCard();
    buildAndRenderTrip(false);
    renderAlertsView();
  }

  function bindEvents() {
    document.querySelectorAll(".web-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    document.querySelectorAll("#yearToggleBar .year-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const yr = Number(btn.dataset.year);
        if (yr !== state.activeYear) {
          switchYear(yr);
          showToast(
            yr >= 2027
              ? "2027년 개화 예측 모드로 전환했습니다."
              : "2026년 기상청 실측 검증 모드로 전환했습니다."
          );
        }
      });
    });

    document.getElementById("tripYearBadge")?.addEventListener("click", () => {
      const nextYr = state.activeYear >= 2027 ? 2026 : 2027;
      switchYear(nextYr);
      showToast(
        nextYr >= 2027
          ? "2027년 예측 기준으로 로드트립 일정을 재계산했습니다."
          : "2026년 실측 기준으로 로드트립 일정을 재계산했습니다."
      );
    });

    document.getElementById("datePickerInput").addEventListener("change", (e) => {
      if (e.target.value) setTargetDate(e.target.value);
    });

    document.getElementById("alertDatePicker").addEventListener("change", (e) => {
      if (e.target.value) setTargetDate(e.target.value);
    });

    document.getElementById("dateSlider").addEventListener("input", (e) => {
      setTargetDate(sliderIndexToDate(e.target.value));
    });

    document.getElementById("stationSearchInput").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) return;
      const found = DATA.stations.find(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.region.toLowerCase().includes(q) ||
          s.spotName.toLowerCase().includes(q) ||
          s.festival.name.toLowerCase().includes(q)
      );
      if (found) selectStation(found.id, true);
    });

    document.getElementById("btnAnimateNorth").addEventListener("click", toggleNorthAnimation);
    document.getElementById("btnFitKorea").addEventListener("click", () => {
      maps.main.fitBounds(KOREA_BOUNDS, { padding: [16, 16], animate: true });
    });

    document.getElementById("recommendBar").addEventListener("click", () => switchView("trip"));

    document.getElementById("btnWatchToggle").addEventListener("click", () => {
      toggleWatchlist(state.selectedStationId);
    });

    document.getElementById("btnGoTripWithCity").addEventListener("click", () => {
      document.getElementById("tripOrigin").value = state.selectedStationId;
      renderDateUI();
      switchView("trip");
      buildAndRenderTrip(true);
    });

    document.getElementById("tripOrigin").addEventListener("change", () => {
      renderDateUI();
      renderRecommendBanner();
    });

    document.getElementById("tripTransport").addEventListener("change", () => {
      renderRecommendBanner();
      buildAndRenderTrip(false);
    });

    document.getElementById("btnBuildTrip").addEventListener("click", () => buildAndRenderTrip(true));

    document.getElementById("reportForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const stationId = document.getElementById("reportStation").value;
      const dateVal = document.getElementById("reportDate").value;
      const stageSel = document.getElementById("reportStageSelect");
      const bloomPct = Number(stageSel.value);
      const stageLabel = stageSel.options[stageSel.selectedIndex].text.split(" (")[0];
      const photoFile = document.getElementById("reportPhoto").files[0];
      const st = DATA.stations.find((s) => s.id === stationId);

      const ev = state.currentEvaluations.find((item) => item.station.id === stationId);
      const diffFromOpen = H.diffDaysIso(ev.predictedOpenDate, dateVal);
      let offsetDays = 0;
      if (bloomPct >= 70 && diffFromOpen < 3) offsetDays = -1;
      else if (bloomPct <= 10 && diffFromOpen > 2) offsetDays = 1;

      const saveRecord = (photoDataUrl) => {
        state.reports.unshift({
          id: `rep-${Date.now()}`,
          stationId,
          stationName: st.name,
          date: dateVal,
          stageLabel,
          bloomPct,
          trustScore: photoDataUrl ? 96 : 88,
          offsetDays,
          note: `${st.name} 현장 목격 제보 (${stageLabel})`,
          photoDataUrl,
        });
        localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(state.reports.slice(0, 15)));
        state.extraNotifications.unshift({
          icon: "💬",
          title: `제보 반영 완료 · ${st.name}`,
          body: `내가 올린 제보(${stageLabel})가 모델 보정에 반영됐어요`,
          time: "방금 전",
        });
        refreshAllViews();
        showToast(`${st.name} 제보가 등록되어 알림과 모델 보정에 반영되었습니다.`);
      };

      if (photoFile) {
        const reader = new FileReader();
        reader.onload = () => saveRecord(reader.result);
        reader.readAsDataURL(photoFile);
      } else {
        saveRecord(null);
      }
    });

    document.getElementById("btnLiveSync").addEventListener("click", syncLiveOpenMeteo);
  }

  function init() {
    populateSelects();
    initMaps();
    bindEvents();
    switchYear(state.activeYear, state.targetDate);

    const initialHash = window.location.hash.replace("#", "");
    if (["map", "trip", "alert"].includes(initialHash) && initialHash !== "map") {
      switchView(initialHash);
    }
  }

  init();
})();
