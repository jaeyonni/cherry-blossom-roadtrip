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

  const KOREA_BOUNDS = [
    [33.15, 126.2],
    [38.05, 129.45],
  ];

  const SLIDER_START_DATE = "2026-03-01";
  const SLIDER_DAYS_COUNT = 51;

  const STORAGE_KEYS = {
    WATCHLIST: "cherry_watchlist_v1",
    REPORTS: "cherry_reports_v1",
  };

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

  const state = {
    activeView: "map",
    targetDate: "2026-03-29",
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
    return H.addDaysIso(SLIDER_START_DATE, Number(idx));
  }

  function dateToSliderIndex(isoDate) {
    const diff = H.diffDaysIso(SLIDER_START_DATE, isoDate);
    return Math.max(0, Math.min(SLIDER_DAYS_COUNT - 1, diff));
  }

  function getReportsCalibrationMap() {
    const map = {};
    for (const r of state.reports) {
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
    maps.tripRouteLayer.clearLayers();
    maps.tripMarkersLayer.clearLayers();

    if (!trip || !trip.itinerary.length) return;

    const stops = [trip.originStation, ...trip.itinerary.map((d) => d.toStation)];
    const uniqueStops = stops.filter((st, idx) => idx === 0 || st.id !== stops[idx - 1].id);
    if (uniqueStops.length < 2) return;

    const hasIslandCross = uniqueStops.some((s) => s.isIsland) && uniqueStops.some((s) => !s.isIsland);
    const cacheKey = uniqueStops.map((s) => s.id).join("-");

    let latLngs = null;
    if (!hasIslandCross && trip.transportMode === "car") {
      if (osrmRouteCache.has(cacheKey)) {
        latLngs = osrmRouteCache.get(cacheKey);
      } else {
        try {
          const coordParam = uniqueStops.map((s) => `${s.lon},${s.lat}`).join(";");
          const url = `https://router.project-osrm.org/route/v1/driving/${coordParam}?overview=full&geometries=geojson`;
          const resp = await fetch(url);
          if (resp.ok) {
            const json = await resp.json();
            if (json.routes?.[0]?.geometry?.coordinates) {
              latLngs = json.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon]);
              osrmRouteCache.set(cacheKey, latLngs);
            }
          }
        } catch (_) {}
      }
    }

    const fallbackLatLngs = uniqueStops.map((s) => [s.lat, s.lon]);
    const polyPoints = latLngs || fallbackLatLngs;
    const style = {
      color: trip.transportMode === "car" ? "#1D352B" : "#B85D79",
      weight: latLngs ? 5 : 3.5,
      opacity: 0.85,
      dashArray: latLngs ? null : "8 8",
    };

    const tripPoly = L.polyline(polyPoints, style).addTo(maps.tripRouteLayer);

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
      maps.trip.fitBounds(tripPoly.getBounds().pad(0.24));
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
    document.getElementById("mapSubDate").textContent = formatFullKoreanDate(state.targetDate);
    const originId = document.getElementById("tripOrigin")?.value || "108";
    const originName = DATA.stations.find((s) => s.id === originId)?.name || "서울";
    document.getElementById("mapSubOrigin").textContent = `${originName} 출발`;
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
    // 육지 우선으로 가장 추천할 만한 명소 선정 (만개 우선 + 축제 진행 중)
    const ranked = [...state.currentEvaluations].sort((a, b) => {
      const stageScore = (e) => (e.stage.key === "full" ? 30 : e.stage.key === "opening" ? 20 : 0);
      const festA = a.station.festival && state.targetDate >= a.station.festival.start && state.targetDate <= a.station.festival.end ? 8 : 0;
      const festB = b.station.festival && state.targetDate >= b.station.festival.start && state.targetDate <= b.station.festival.end ? 8 : 0;
      const mainlandA = a.station.isIsland ? 0 : 4;
      const mainlandB = b.station.isIsland ? 0 : 4;
      return stageScore(b) + festB + mainlandB - (stageScore(a) + festA + mainlandA);
    });
    const best = ranked[0];
    if (!best) return;

    const leg = H.getTravelLeg(
      DATA.routingMatrix,
      originId,
      best.station.id,
      best.station.isIsland ? "transit" : "car"
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
    const travelLabel = best.station.isIsland
      ? `항공 약 ${H.formatDurationMinutes(leg.minutes)}`
      : `이동 ${H.formatDurationMinutes(leg.minutes)}`;

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

    const vsNormStr =
      ev.daysVsNormal === 0
        ? "평년 개화일과 동일합니다"
        : ev.daysVsNormal < 0
        ? `평년(${formatMonthDayKorean(ev.normalBloomDate)})보다 ${Math.abs(ev.daysVsNormal)}일 빠르게 개화합니다`
        : `평년(${formatMonthDayKorean(ev.normalBloomDate)})보다 ${ev.daysVsNormal}일 늦게 개화합니다`;
    document.getElementById("selectedCityVsNormal").textContent = vsNormStr;

    const fest = st.festival;
    document.getElementById("selectedCityFestival").innerHTML = `
      <strong>🎪 지역 벚꽃축제:</strong> ${fest.name}<br/>
      <span style="color:var(--text-muted);">${fest.start} ~ ${fest.end} · ${fest.location}</span>
    `;

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

    const nights = Math.max(0, trip.totalDays - 1);
    const stayLabel = nights === 0 ? "당일치기" : `${nights}박 ${trip.totalDays}일`;
    document.getElementById("tripHeaderSummary").textContent = `${H.formatKoreanDate(trip.startDate)} ~ ${H.formatKoreanDate(trip.endDate)} · ${stayLabel} · 총 이동 ${H.formatDurationMinutes(trip.totalMinutes)}`;

    const listEl = document.getElementById("tripItineraryList");
    if (!trip.itinerary.length) {
      listEl.innerHTML = `<div style="padding:12px; color:var(--text-muted);">선택하신 조건에 맞는 일정을 생성할 수 없습니다.</div>`;
      return;
    }

    listEl.innerHTML = trip.itinerary
      .map((day, idx) => {
        const circleClass = idx === 0 ? "day1" : idx === 1 ? "day2" : "";
        const festBadge = day.isFestivalActive
          ? `<span class="stage-pill" style="background:var(--pink-tint); color:var(--pink-full); margin-top:6px;">🎪 ${day.festival.name}</span>`
          : `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:5px;">추천 명소: ${day.toStation.spotName}</div>`;

        return `
          <div class="day-card" data-station="${day.toStation.id}">
            <div class="step-circle ${circleClass}">${day.dayNumber}</div>
            <div>
              <div style="font-size:0.74rem; font-weight:700; color:var(--text-muted);">DAY ${day.dayNumber} · ${day.dateLabel}</div>
              <div style="font-size:1.02rem; font-weight:800; color:var(--green-deep); margin:2px 0 4px;">
                ${day.fromStation.name} → ${day.toStation.name}
              </div>
              <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span style="font-size:0.79rem; color:var(--text-muted);">
                  ${day.leg.modeLabel} ${H.formatDurationMinutes(day.leg.minutes)}
                </span>
                <span class="stage-pill" style="background:${day.stage.bgTint}; color:${day.stage.textColor};">
                  ${day.stage.label}
                </span>
              </div>
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

    drawTripRouteOnTripMap(trip, shouldNotify);
    if (shouldNotify) {
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
      box.className = "hazard-box";
      box.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div style="flex:1;">
            <div style="font-size:0.96rem; font-weight:800; margin-bottom:5px;">
              ⚠️ 실측 강수 집중 주의 · ${top.station.name} 외 ${Math.max(0, activeAlerts.length - 1)}곳
            </div>
            <div style="font-size:0.83rem; line-height:1.5; margin-bottom:6px;">
              ${formatFullKoreanDate(state.targetDate)} 실제 관측 강수량이 집중되었습니다: <strong>${regionListText}</strong>${wamisRef}. 여행 전 기상 확인 및 일정 조정을 고려하세요.
            </div>
            <div style="font-size:0.74rem; opacity:0.85;">Open-Meteo 실측 일강수량 데이터 기준</div>
          </div>
          <button type="button" class="btn-pink" id="btnRerouteSafe">
            강수 지역 피해서 일정 다시 짜기 →
          </button>
        </div>
      `;

      document.getElementById("btnRerouteSafe").addEventListener("click", () => {
        document.getElementById("tripExcludeHazard").checked = true;
        document.getElementById("tripStartDate").value = state.targetDate;
        const endDateVal = H.addDaysIso(state.targetDate, 2);
        document.getElementById("tripEndDate").value = endDateVal <= "2026-04-20" ? endDateVal : "2026-04-20";
        switchView("trip");
        buildAndRenderTrip(true);
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
  async function syncLiveOpenMeteo() {
    const btn = document.getElementById("btnLiveSync");
    btn.disabled = true;
    btn.textContent = "⏳ 최신 기상 반영중...";

    try {
      const lats = DATA.stations.map((s) => s.lat).join(",");
      const lons = DATA.stations.map((s) => s.lon).join(",");
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
        let cumGdd = 0,
          cumP = 0,
          cumEt = 0,
          cumQ = 0,
          cumDs = 0;

        DATA.daily2026[st.id] = daily.time.map((dStr, i) => {
          const tMax = daily.temperature_2m_max[i] ?? 0;
          const tMin = daily.temperature_2m_min[i] ?? 0;
          const tMeanHL = Number(((tMax + tMin) / 2).toFixed(2));
          const tMean = Number((daily.temperature_2m_mean[i] ?? tMeanHL).toFixed(2));
          const precip = Number((daily.precipitation_sum[i] ?? 0).toFixed(2));
          const et0 = Number((daily.et0_fao_evapotranspiration[i] ?? 1.0).toFixed(2));
          const q = precip > 5 ? Number(((precip - 5) * 0.28).toFixed(2)) : 0;
          const deltaS = Number((precip - et0 - q).toFixed(2));
          let dailyGdd = 0;
          if (dStr >= "2026-02-07") {
            dailyGdd = Math.max(0, tMeanHL - 1.2);
            cumGdd = Number((cumGdd + dailyGdd).toFixed(2));
            cumP = Number((cumP + precip).toFixed(2));
            cumEt = Number((cumEt + et0).toFixed(2));
            cumQ = Number((cumQ + q).toFixed(2));
            cumDs = Number((cumDs + deltaS).toFixed(2));
          }
          return {
            date: dStr,
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
      });

      refreshAllViews();
      showToast("최신 기온·강수 데이터를 불러와 개화 예측을 갱신했습니다.");
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

  function toggleNorthAnimation() {
    const btn = document.getElementById("btnAnimateNorth");
    if (state.isAnimatingNorth) {
      clearInterval(state.animTimer);
      state.isAnimatingNorth = false;
      btn.textContent = "▶ 매주 북상 보기";
      return;
    }

    state.isAnimatingNorth = true;
    btn.textContent = "⏸ 정지";
    let stepDate = "2026-03-18";
    setTargetDate(stepDate);

    state.animTimer = setInterval(() => {
      stepDate = H.addDaysIso(stepDate, 1);
      if (stepDate > "2026-04-15") stepDate = "2026-03-18";
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
    refreshAllViews();

    const initialHash = window.location.hash.replace("#", "");
    if (["map", "trip", "alert"].includes(initialHash) && initialHash !== "map") {
      switchView(initialHash);
    }
  }

  init();
})();
