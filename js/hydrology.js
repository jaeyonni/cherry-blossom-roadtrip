/**
 * 수문학 기반 벚꽃 개화 예측 및 로드트립 경로 최적화 엔진
 *
 * 1. 적산온도(GDD) 열에너지 누적 모델:
 *    GDD(t) = Σ_{d >= 02-07}^{t} max( (T_max + T_min)/2 + ΔT - T_base, 0 )
 *    - 기본 기준온도 T_base = 1.2°C, 누적 시작일 2월 7일 (Shi et al., 2014)
 *
 * 2. 물수지 보정 모델 (Viessman & Lewis, 1996):
 *    P = ET + Q + ΔS  =>  ΔS_d = P_d - ET0_d - Q_d
 *    - ΔS > 기준값 (강수 증가/습윤): 증발산 스트레스 완화로 개화 다소 지연 (유효 임계값 ↑)
 *    - ΔS < 기준값 (가뭄 지속/건조): 증발산 스트레스로 개화 다소 조기화 (유효 임계값 ↓)
 */

(function (global) {
  "use strict";

  const DEFAULT_BASELINE_DELTA_S = -40.0; // 전국 내륙 봄철(2~3월) 평균 누적 물수지 저류변화 기준(mm)
  const WATER_BALANCE_COUPLING_K = 0.22; // ΔS 1mm 변화당 유효 GDD 임계값 보정 계수 (°C·day / mm)

  const STAGE_META = {
    scheduled: {
      key: "scheduled",
      label: "예정",
      color: "#C4C0B8",
      textColor: "#4B4743",
      bgTint: "#EFECE6",
      description: "아직 적산온도 임계값 미도달",
    },
    opening: {
      key: "opening",
      label: "개화 시작",
      color: "#F2B8C6",
      textColor: "#8E2F4D",
      bgTint: "#FDF0F4",
      description: "예측 개화일 도달 (3송이 이상 개화)",
    },
    full: {
      key: "full",
      label: "만개",
      color: "#B85D79",
      textColor: "#8E2949",
      bgTint: "#F7E2E9",
      description: "개화 80% 이상 · 방문 최적기",
    },
    ended: {
      key: "ended",
      label: "종료",
      color: "#6E6A66",
      textColor: "#4A4642",
      bgTint: "#EAE6E1",
      description: "낙화 진행 · 다음 북쪽 지역 이동 시점",
    },
  };

  function addDaysIso(isoDate, deltaDays) {
    const dt = new Date(`${isoDate}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }

  function diffDaysIso(dateA, dateB) {
    const a = new Date(`${dateA}T00:00:00Z`).getTime();
    const b = new Date(`${dateB}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86400000);
  }

  function formatKoreanDate(isoDate) {
    if (!isoDate) return "-";
    const [, mm, dd] = isoDate.split("-");
    const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
    const d = new Date(`${isoDate}T00:00:00Z`);
    const wd = weekdays[d.getUTCDay()];
    return `${Number(mm)}/${Number(dd)}(${wd})`;
  }

  function formatShortMonthDay(isoDate) {
    if (!isoDate) return "-";
    const [, mm, dd] = isoDate.split("-");
    return `${Number(mm)}/${Number(dd)}`;
  }

  function formatDurationMinutes(totalMinutes) {
    if (totalMinutes == null || Number.isNaN(totalMinutes)) return "이동시간 확인중";
    const mins = Math.round(totalMinutes);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}분`;
    if (m === 0) return `${h}시간`;
    return `${h}시간 ${m}분`;
  }

  /**
   * 단일 관측지점에 대해 모델 파라미터(tBase, tempShift, precipScalePct, waterBalanceEnabled, reportOffsetDays)를 적용해
   * 2026-02-01 ~ 2026-04-25 전체 일별 GDD, 물수지, 예측 개화일/만개일/종료일을 재계산한다.
   */
  function simulateStation(station, rawDailySeries, options = {}) {
    const tBase = options.tBase ?? 1.2;
    const tempShift = options.tempShift ?? 0.0;
    const precipScale = 1 + (options.precipScalePct ?? 0) / 100;
    const waterBalanceEnabled = options.waterBalanceEnabled ?? true;
    const useLiteratureThreshold = options.useLiteratureThreshold ?? false;
    const reportOffsetDays = options.reportOffsetDays ?? 0;
    const fullBloomOffsetDays = options.fullBloomOffsetDays ?? 6;
    const endOffsetDays = options.endOffsetDays ?? 13;

    // 순수 열적 기준 임계값 역산:
    // 관측 2026 개화일 기준 calibratedThresholdGdd에서 관측 ΔS 효과를 분리해 thermalBaseThreshold 산출
    const obsDeltaS = station.obs2026CumDeltaS ?? DEFAULT_BASELINE_DELTA_S;
    const calThreshold = useLiteratureThreshold
      ? station.referenceThresholdGdd || 371.5
      : station.calibratedThresholdGdd;

    const thermalBaseThreshold = useLiteratureThreshold
      ? calThreshold
      : calThreshold - WATER_BALANCE_COUPLING_K * (obsDeltaS - DEFAULT_BASELINE_DELTA_S);

    const round2 = (x) => Math.round(x * 100) / 100;

    let cumGdd = 0;
    let cumP = 0;
    let cumEt = 0;
    let cumQ = 0;
    let cumDeltaS = 0;

    let predictedOpenDate = null;
    const series = [];

    for (let i = 0; i < rawDailySeries.length; i++) {
      const row = rawDailySeries[i];
      const dStr = row.date;
      const tMaxAdj = row.tMax + tempShift;
      const tMinAdj = row.tMin + tempShift;
      const tMeanHL = round2((tMaxAdj + tMinAdj) / 2);
      const tMeanObsAdj = row.tMean + tempShift;

      const pAdj = round2(Math.max(0, row.precip * precipScale));
      const etAdj = round2(row.et0);
      const qAdj = pAdj > 5.0 ? round2((pAdj - 5.0) * 0.28) : 0.0;
      const dsDaily = round2(pAdj - etAdj - qAdj);

      let dailyGdd = 0;
      if (dStr >= "2026-02-07") {
        dailyGdd = Math.max(0, tMeanHL - tBase);
        cumGdd = round2(cumGdd + dailyGdd);
        cumP = round2(cumP + pAdj);
        cumEt = round2(cumEt + etAdj);
        cumQ = round2(cumQ + qAdj);
        cumDeltaS = round2(cumDeltaS + dsDaily);
      }

      const wbAdjustmentGdd = waterBalanceEnabled
        ? WATER_BALANCE_COUPLING_K * (cumDeltaS - DEFAULT_BASELINE_DELTA_S)
        : 0;
      const effectiveThreshold = Math.max(80, thermalBaseThreshold + wbAdjustmentGdd);

      if (!predictedOpenDate && dStr >= "2026-02-07" && cumGdd >= effectiveThreshold - 0.05) {
        predictedOpenDate = dStr;
      }

      series.push({
        date: dStr,
        tMax: Number(tMaxAdj.toFixed(1)),
        tMin: Number(tMinAdj.toFixed(1)),
        tMean: Number(tMeanObsAdj.toFixed(1)),
        precip: Number(pAdj.toFixed(1)),
        et0: Number(etAdj.toFixed(2)),
        runoffQ: Number(qAdj.toFixed(2)),
        deltaS: Number(dsDaily.toFixed(2)),
        dailyGdd: Number(dailyGdd.toFixed(2)),
        cumGdd: Number(cumGdd.toFixed(1)),
        cumPrecip: Number(cumP.toFixed(1)),
        cumEt0: Number(cumEt.toFixed(1)),
        cumRunoffQ: Number(cumQ.toFixed(1)),
        cumDeltaS: Number(cumDeltaS.toFixed(1)),
        effectiveThreshold: Number(effectiveThreshold.toFixed(1)),
        wbAdjustmentGdd: Number(wbAdjustmentGdd.toFixed(1)),
      });
    }

    if (!predictedOpenDate) {
      predictedOpenDate = "2026-04-22";
    }

    // 사용자 커뮤니티 현장 제보 보정(reportOffsetDays) 반영
    const finalOpenDate = addDaysIso(predictedOpenDate, reportOffsetDays);
    const finalFullDate = addDaysIso(finalOpenDate, fullBloomOffsetDays);
    const finalEndDate = addDaysIso(finalOpenDate, endOffsetDays);

    return {
      station,
      series,
      byDate: Object.fromEntries(series.map((r) => [r.date, r])),
      thermalBaseThreshold: Number(thermalBaseThreshold.toFixed(1)),
      predictedOpenDate: finalOpenDate,
      predictedFullDate: finalFullDate,
      predictedEndDate: finalEndDate,
      normalBloomDate: `2026-${station.normalBloom}`,
      obsBloom2026Date: `2026-${station.obsBloom2026}`,
      daysVsNormal: diffDaysIso(`2026-${station.normalBloom}`, finalOpenDate),
    };
  }

  /**
   * 특정 기준 날짜(targetDate)에 대한 지점의 개화 단계 판정
   */
  function getStageOnDate(simResult, targetDate) {
    if (targetDate < simResult.predictedOpenDate) {
      return STAGE_META.scheduled;
    }
    if (targetDate < simResult.predictedFullDate) {
      return STAGE_META.opening;
    }
    if (targetDate < simResult.predictedEndDate) {
      return STAGE_META.full;
    }
    return STAGE_META.ended;
  }

  function getProgressPctOnDate(simResult, targetDate) {
    const row = simResult.byDate[targetDate];
    if (!row) return 0;
    const pct = Math.min(120, Math.round((row.cumGdd / row.effectiveThreshold) * 100));
    return Math.max(0, pct);
  }

  /**
   * 전국 모든 관측소에 대해 시뮬레이션 수행 및 특정 날짜 스냅샷 생성
   */
  function evaluateAllStations(data, targetDate, options = {}) {
    const reportsByStation = options.reportsByStation || {};
    const results = [];
    for (const st of data.stations) {
      const reportOffsetDays = reportsByStation[st.id]?.offsetDays || 0;
      const sim = simulateStation(st, data.daily2026[st.id], {
        ...options,
        reportOffsetDays,
      });
      const stage = getStageOnDate(sim, targetDate);
      const dayMetrics = sim.byDate[targetDate] || sim.series[sim.series.length - 1];
      const progressPct = getProgressPctOnDate(sim, targetDate);

      results.push({
        ...sim,
        targetDate,
        stage,
        dayMetrics,
        progressPct,
      });
    }
    return results;
  }

  /**
   * 두 지점 간 이동 소요시간(분), 거리(km), 이동수단 라벨 조회 (OSRM 실측 + KTX/시외버스)
   */
  function getTravelLeg(routingMatrix, fromStationId, toStationId, transportMode = "car") {
    const ids = routingMatrix.stationIds;
    const i = ids.indexOf(fromStationId);
    const j = ids.indexOf(toStationId);
    if (i === -1 || j === -1) {
      return { minutes: 120, km: 140, modeLabel: "도로 이동" };
    }
    if (transportMode === "transit") {
      return {
        minutes: routingMatrix.transitMinutes[i][j],
        km: routingMatrix.drivingKm[i][j],
        modeLabel: routingMatrix.transitModes[i][j],
      };
    }
    return {
      minutes: routingMatrix.drivingMinutes[i][j],
      km: routingMatrix.drivingKm[i][j],
      modeLabel: "자동차",
    };
  }

  /**
   * 기능 2: 로드트립 경로 자동 추천 알고리즘 (발표자료 12p 구현)
   * - STEP 1: 출발지, 날짜 범위(시작일~종료일), 교통수단, 호우특보 지역 제외 여부 입력
   * - STEP 2: 여행 일자별 '개화 시작 ~ 만개' 단계인 지역 자동 필터링 (제주 섬 지역은 출발지거나 옵션 허용 시 포함)
   * - STEP 3: 남→북 개화 전선 및 이동시간을 함께 고려해 일자별 최적 동선 구성
   */
  function planRoadTrip(data, evaluations, params) {
    const {
      originId = "108",
      startDate = "2026-04-03",
      endDate = "2026-04-05",
      transportMode = "car",
      includeJeju = false,
      excludeHazard = true,
      blockedStationIds = [],
    } = params;

    const totalDays = Math.max(1, Math.min(7, diffDaysIso(startDate, endDate) + 1));
    const evalMap = Object.fromEntries(evaluations.map((e) => [e.station.id, e]));
    const originStation = data.stations.find((s) => s.id === originId) || data.stations[0];

    const visitedIds = new Set();
    const itinerary = [];
    let prevStationId = originId;
    let totalMinutes = 0;
    let totalKm = 0;

    for (let dayIdx = 0; dayIdx < totalDays; dayIdx++) {
      const currentDate = addDaysIso(startDate, dayIdx);
      const dayHazards = excludeHazard ? evaluateWeatherHazards(data, currentDate) : [];
      const dayBlockedSet = new Set([
        ...blockedStationIds,
        ...dayHazards.filter((h) => h.activeAlert).map((h) => h.station.id),
      ]);

      // 후보 지역 필터링: 해당 날짜에 '만개' 또는 '개화 시작'이고 실측 강수 집중 지역이 아닌 곳
      let candidates = evaluations.filter((ev) => {
        const st = ev.station;
        if (visitedIds.has(st.id)) return false;
        if (dayBlockedSet.has(st.id)) return false;
        if (st.id === originId && totalDays > 1 && dayIdx === 0) return false;
        if (!includeJeju && st.isIsland && !originStation.isIsland) return false;

        const stStage = getStageOnDate(ev, currentDate);
        return stStage.key === "full" || stStage.key === "opening";
      });

      // 만약 해당 기간에 개화 중 지역이 부족하면 '예정(곧 개화)' 중 가장 GDD 진행률 높은 지역 보완
      let fallbackNotice = false;
      if (candidates.length === 0) {
        fallbackNotice = true;
        candidates = evaluations
          .filter((ev) => {
            if (visitedIds.has(ev.station.id)) return false;
            if (dayBlockedSet.has(ev.station.id)) return false;
            if (!includeJeju && ev.station.isIsland && !originStation.isIsland) return false;
            return true;
          })
          .sort((a, b) => getProgressPctOnDate(b, currentDate) - getProgressPctOnDate(a, currentDate));
      }

      if (candidates.length === 0) break;

      // 점수 계산: 만개(+30), 개화 시작(+22), 축제 기간 일치(+14), 남→북 진행 방향(+위도 순위), 이동시간 패널티
      // 마지막 날일수록 출발지 복귀 편의성도 약간 가중
      const scored = candidates.map((ev) => {
        const st = ev.station;
        const stStage = getStageOnDate(ev, currentDate);
        const leg = getTravelLeg(data.routingMatrix, prevStationId, st.id, transportMode);
        const fest = st.festival;
        const isFestivalActive = fest && currentDate >= fest.start && currentDate <= fest.end;

        let score = 0;
        if (stStage.key === "full") score += 35;
        else if (stStage.key === "opening") score += 25;
        else score += 5;

        if (isFestivalActive) score += 16;

        // 남->북 배열 보너스 (초기 일정엔 남쪽, 후반 일정엔 북쪽 우대)
        const latNorm = (st.lat - 33.0) / 5.0; // 0(남) ~ 1(북)
        const dayRatio = totalDays === 1 ? 0.5 : dayIdx / (totalDays - 1);
        score += (1 - Math.abs(latNorm - dayRatio)) * 18;

        // 이동시간이 지나치게 길지 않도록 (180분 이내 선호)
        const mins = leg.minutes ?? 240;
        score -= mins / 15.0;

        return { ev, stStage, leg, isFestivalActive, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const picked = scored[0];
      const prevStation = evalMap[prevStationId]?.station || originStation;

      visitedIds.add(picked.ev.station.id);
      totalMinutes += picked.leg.minutes || 0;
      totalKm += picked.leg.km || 0;

      itinerary.push({
        dayNumber: dayIdx + 1,
        date: currentDate,
        dateLabel: formatKoreanDate(currentDate),
        fromStation: prevStation,
        toStation: picked.ev.station,
        stage: picked.stStage,
        leg: picked.leg,
        isFestivalActive: picked.isFestivalActive,
        festival: picked.ev.station.festival,
        dayMetrics: picked.ev.byDate[currentDate] || picked.ev.dayMetrics,
        fallbackNotice,
      });

      prevStationId = picked.ev.station.id;
    }

    return {
      originStation,
      startDate,
      endDate,
      totalDays,
      transportMode,
      blockedStationIds,
      itinerary,
      totalMinutes,
      totalKm: Number(totalKm.toFixed(1)),
    };
  }

  /**
   * 실측 일강수량 기반 강수 위험 경보 분석 (임의 시뮬레이션 값 미사용)
   * - Open-Meteo Archive 실측 일강수량 >= 30mm 또는 48시간 누적 >= 40mm 시 강수 주의 판정
   * - WAMIS 인근 하천 관측소 공식 홍수주의보 기준 수위 정보 병기
   */
  function evaluateWeatherHazards(data, targetDate) {
    const alerts = [];
    for (const st of data.stations) {
      const series = data.daily2026[st.id];
      const idx = series.findIndex((r) => r.date === targetDate);
      const dayRow = idx >= 0 ? series[idx] : series[series.length - 1];
      const prevRow = idx > 0 ? series[idx - 1] : dayRow;
      const rainTodayMm = Number((dayRow?.precip || 0).toFixed(1));
      const rain2DayMm = Number((rainTodayMm + (prevRow?.precip || 0)).toFixed(1));

      const activeAlert = rainTodayMm >= 30.0 || rain2DayMm >= 40.0;

      alerts.push({
        station: st,
        date: targetDate,
        rainTodayMm,
        rain2DayMm,
        activeAlert,
        alertTitle: activeAlert
          ? `강수 집중 주의 · ${st.name} (일 ${rainTodayMm}mm / 48h ${rain2DayMm}mm)`
          : `기상 양호 · ${st.name}`,
        riverStatus: st.wamisStation ? { ...st.wamisStation } : null,
      });
    }

    alerts.sort(
      (a, b) =>
        Number(b.activeAlert) - Number(a.activeAlert) ||
        b.rainTodayMm - a.rainTodayMm ||
        b.rain2DayMm - a.rain2DayMm
    );
    return alerts;
  }

  global.CherryHydrology = {
    STAGE_META,
    DEFAULT_BASELINE_DELTA_S,
    WATER_BALANCE_COUPLING_K,
    addDaysIso,
    diffDaysIso,
    formatKoreanDate,
    formatShortMonthDay,
    formatDurationMinutes,
    simulateStation,
    getStageOnDate,
    getProgressPctOnDate,
    evaluateAllStations,
    getTravelLeg,
    planRoadTrip,
    evaluateWeatherHazards,
  };
})(window);
