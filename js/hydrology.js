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

  // 제주 ↔ 육지 국내선 항공 + 공항 접근 소요시간 (순수 비행시간 + 공항/시내 이동시간 기준)
  const JEJU_CITY_ACCESS_MIN = 10; // 제주국제공항 ↔ 제주시내
  const SEOGWIPO_ACCESS_MIN = 50; // 제주국제공항 ↔ 서귀포 시내

  const VERIFIED_JEJU_FLIGHTS = {
    "108": { airport: "김포", flightMin: 70, accessMin: 35 },
    "119": { airport: "김포", flightMin: 70, accessMin: 55 },
    "131": { airport: "청주", flightMin: 65, accessMin: 25 },
    "133": { airport: "청주", flightMin: 65, accessMin: 45 },
    "143": { airport: "대구", flightMin: 65, accessMin: 25 },
    "283": { airport: "포항경주", flightMin: 65, accessMin: 35 },
    "159": { airport: "김해", flightMin: 65, accessMin: 30 },
    "155": { airport: "김해", flightMin: 65, accessMin: 40 },
    "156": { airport: "광주", flightMin: 55, accessMin: 25 },
    "146": { airport: "군산", flightMin: 55, accessMin: 50 },
    "168": { airport: "여수", flightMin: 55, accessMin: 25 },
    "101": { airport: "원주", flightMin: 70, accessMin: 60 },
    "105": { airport: "원주", flightMin: 70, accessMin: 75 },
  };

  // 내륙 정기 국내선 직항 노선 (대구는 평시 정기 내륙 노선 미운항으로 제외)
  const VERIFIED_DOMESTIC_FLIGHTS = {
    "108-159": { fromAirport: "김포", toAirport: "김해", flightMin: 60, accessMin: 65 },
    "119-159": { fromAirport: "김포", toAirport: "김해", flightMin: 60, accessMin: 85 },
    "108-155": { fromAirport: "김포", toAirport: "김해", flightMin: 60, accessMin: 75 },
    "108-168": { fromAirport: "김포", toAirport: "여수", flightMin: 55, accessMin: 60 },
    "108-156": { fromAirport: "김포", toAirport: "광주", flightMin: 55, accessMin: 60 },
    "108-283": { fromAirport: "김포", toAirport: "포항경주", flightMin: 55, accessMin: 70 },
  };

  // 전국 고속·시외버스 주요 공시 소요시간(분)
  const VERIFIED_EXPRESS_BUS_MINUTES = {
    "108-119": 55,
    "108-101": 90,
    "108-131": 90,
    "108-133": 120,
    "108-146": 160,
    "108-105": 170,
    "108-156": 200,
    "108-143": 210,
    "108-283": 210,
    "108-155": 235,
    "108-159": 240,
    "108-168": 255,
    "184-189": 65,
    "159-155": 60,
    "159-283": 55,
    "159-143": 75,
    "143-283": 55,
    "146-156": 70,
    "133-131": 45,
    "133-146": 65,
    "133-143": 115,
    "133-156": 130,
    "156-168": 100,
  };

  // 코레일 KTX / ITX-청춘 실제 공시 소요시간(분)
  const VERIFIED_RAIL_MINUTES = {
    "108-119": 34,
    "108-131": 72,
    "108-133": 59,
    "108-143": 108,
    "108-159": 158,
    "108-146": 98,
    "108-156": 108,
    "108-283": 128,
    "108-155": 172,
    "108-105": 115,
    "108-101": 72,
    "108-168": 168,
    "119-133": 65,
    "119-143": 112,
    "119-159": 162,
    "131-133": 35,
    "133-143": 45,
    "133-159": 100,
    "133-283": 68,
    "133-146": 68,
    "133-156": 92,
    "133-155": 122,
    "133-168": 125,
    "143-159": 48,
    "143-283": 22,
    "143-155": 66,
    "146-168": 96,
    "159-283": 32,
  };

  function haversineKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return Number((2 * 6371.0 * Math.asin(Math.min(1, Math.sqrt(a)))).toFixed(1));
  }

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
   * 단일 관측지점에 대해 모델 파라미터(year, tBase, tempShift, precipScalePct, waterBalanceEnabled, reportOffsetDays)를 적용해
   * 해당 연도 2/1 ~ 4/25 전체 일별 GDD, 물수지, 예측 개화일/만개일/종료일을 재계산한다.
   */
  function simulateStation(station, rawDailySeries, options = {}) {
    const year = Number(options.year || rawDailySeries?.[0]?.date?.slice(0, 4) || 2026);
    const tBase = options.tBase ?? 1.2;
    const tempShift = options.tempShift ?? 0.0;
    const precipScale = 1 + (options.precipScalePct ?? 0) / 100;
    const waterBalanceEnabled = options.waterBalanceEnabled ?? true;
    const useLiteratureThreshold = options.useLiteratureThreshold ?? false;
    const reportOffsetDays = options.reportOffsetDays ?? 0;
    const fullBloomOffsetDays = options.fullBloomOffsetDays ?? 6;
    const endOffsetDays = options.endOffsetDays ?? 13;

    // 순수 열적 기준 임계값 역산:
    // 2026년은 2026 단일 캘리브레이션, 2027년+는 2023~2026 4개년 다년 보정 열적 임계값 적용
    const obsDeltaS = station.obs2026CumDeltaS ?? DEFAULT_BASELINE_DELTA_S;
    let thermalBaseThreshold;
    if (useLiteratureThreshold) {
      thermalBaseThreshold = station.referenceThresholdGdd || 371.5;
    } else if (year >= 2027 && station.multiYearThermalThresholdGdd != null) {
      thermalBaseThreshold = station.multiYearThermalThresholdGdd;
    } else {
      thermalBaseThreshold =
        station.calibratedThresholdGdd - WATER_BALANCE_COUPLING_K * (obsDeltaS - DEFAULT_BASELINE_DELTA_S);
    }

    const round2 = (x) => Math.round(x * 100) / 100;
    const startIso = `${year}-02-07`;

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
      if (dStr >= startIso) {
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

      if (!predictedOpenDate && dStr >= startIso && cumGdd >= effectiveThreshold - 0.05) {
        predictedOpenDate = dStr;
      }

      series.push({
        date: dStr,
        dataType: row.dataType || (year <= 2026 ? "observed" : "climatology"),
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
      predictedOpenDate = `${year}-04-22`;
    }

    // 사용자 커뮤니티 현장 제보 보정(reportOffsetDays) 반영
    const finalOpenDate = addDaysIso(predictedOpenDate, reportOffsetDays);
    const finalFullDate = addDaysIso(finalOpenDate, fullBloomOffsetDays);
    const finalEndDate = addDaysIso(finalOpenDate, endOffsetDays);

    return {
      year,
      station,
      series,
      byDate: Object.fromEntries(series.map((r) => [r.date, r])),
      thermalBaseThreshold: Number(thermalBaseThreshold.toFixed(1)),
      predictedOpenDate: finalOpenDate,
      predictedFullDate: finalFullDate,
      predictedEndDate: finalEndDate,
      normalBloomDate: `${year}-${station.normalBloom}`,
      obsBloom2026Date: `2026-${station.obsBloom2026}`,
      daysVsNormal: diffDaysIso(`${year}-${station.normalBloom}`, finalOpenDate),
      daysVs2026: diffDaysIso(`${year}-${station.obsBloom2026}`, finalOpenDate),
      forecastMeta: year >= 2027 ? station.forecast2027Meta || null : null,
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
    const year = Number(options.year || targetDate?.slice(0, 4) || data.defaultYear || 2027);
    const yearSeriesMap =
      data.dailyByYear?.[String(year)] ||
      (year === 2027 ? data.daily2027 : data.daily2026) ||
      data.daily2026;
    const reportsByStation = options.reportsByStation || {};
    const results = [];
    for (const st of data.stations) {
      const reportOffsetDays = reportsByStation[st.id]?.offsetDays || 0;
      const rawSeries = yearSeriesMap?.[st.id] || data.daily2026[st.id];
      const sim = simulateStation(st, rawSeries, {
        ...options,
        year,
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

  function lookupSymmetric(mapObj, idA, idB) {
    return mapObj[`${idA}-${idB}`] ?? mapObj[`${idB}-${idA}`] ?? null;
  }

  /**
   * 기존 routingMatrix에 복합 교통수단(고속버스·KTX·국내선 항공) 및 해상 자동차 차단 정보를 보강한다.
   */
  function ensureMultimodalRouting(data) {
    if (!data || !data.routingMatrix) return null;
    const rm = data.routingMatrix;
    if (rm.multimodalVersion === 2) return rm;

    const idList = rm.stationIds || [];
    const stationById = Object.fromEntries((data.stations || []).map((s) => [s.id, s]));
    const oldDrivingMin = rm.drivingMinutes || [];
    const oldDrivingKm = rm.drivingKm || [];

    const drivingMinutes = [];
    const drivingKm = [];
    const busMinutes = [];
    const busModes = [];
    const railMinutes = [];
    const railModes = [];
    const flightMinutes = [];
    const flightModes = [];
    const flightDetails = [];
    const flightKm = [];
    const transitMinutes = [];
    const transitModes = [];

    for (let i = 0; i < idList.length; i++) {
      const sidA = idList[i];
      const stA = stationById[sidA];
      const dMinRow = [];
      const dKmRow = [];
      const bMinRow = [];
      const bModeRow = [];
      const rMinRow = [];
      const rModeRow = [];
      const fMinRow = [];
      const fModeRow = [];
      const fDetRow = [];
      const fKmRow = [];
      const tMinRow = [];
      const tModeRow = [];

      for (let j = 0; j < idList.length; j++) {
        const sidB = idList[j];
        const stB = stationById[sidB];

        if (i === j) {
          dMinRow.push(0);
          dKmRow.push(0);
          bMinRow.push(0);
          bModeRow.push("동일지점");
          rMinRow.push(null);
          rModeRow.push(null);
          fMinRow.push(null);
          fModeRow.push(null);
          fDetRow.push(null);
          fKmRow.push(0);
          tMinRow.push(0);
          tModeRow.push("동일지점");
          continue;
        }

        const isSeaCrossing = stA && stB ? stA.isIsland !== stB.isIsland : false;
        if (isSeaCrossing) {
          // 육지 ↔ 제주/서귀포 해상 구간은 자동차 이동 불가 -> null 처리 후 국내선 항공으로 계산
          dMinRow.push(null);
          dKmRow.push(null);
          bMinRow.push(null);
          bModeRow.push(null);
          rMinRow.push(null);
          rModeRow.push(null);

          const mainlandId = stA.isIsland ? sidB : sidA;
          const islandId = stA.isIsland ? sidA : sidB;
          const info = VERIFIED_JEJU_FLIGHTS[mainlandId] || { airport: "김포", flightMin: 70, accessMin: 40 };
          const islandAccess = islandId === "189" ? SEOGWIPO_ACCESS_MIN : JEJU_CITY_ACCESS_MIN;
          const totalMin = info.flightMin + info.accessMin + islandAccess;
          const transferMin = info.accessMin + islandAccess;
          const depArr = stA.isIsland ? `제주→${info.airport}` : `${info.airport}→제주`;
          const transferLabel = islandId === "189" ? "공항·서귀포 이동" : "공항 이동";
          const modeStr = `✈️ 비행기 (${depArr})`;

          fMinRow.push(totalMin);
          fModeRow.push(modeStr);
          fDetRow.push(
            `비행 ${formatDurationMinutes(info.flightMin)} + ${transferLabel} ${formatDurationMinutes(transferMin)}`
          );
          fKmRow.push(haversineKm(stA.lat, stA.lon, stB.lat, stB.lon));
          tMinRow.push(totalMin);
          tModeRow.push(modeStr);
          continue;
        }

        const driveM = oldDrivingMin[i]?.[j] ?? null;
        const driveK = oldDrivingKm[i]?.[j] ?? null;
        dMinRow.push(driveM);
        dKmRow.push(driveK);

        let busVal = lookupSymmetric(VERIFIED_EXPRESS_BUS_MINUTES, sidA, sidB);
        if (busVal == null) {
          busVal = Math.round((driveM ?? 150) * 1.15 + 15);
        }
        const busLbl = stA?.isIsland ? "🚌 공항리무진·급행버스" : "🚌 고속·시외버스";
        bMinRow.push(busVal);
        bModeRow.push(busLbl);

        const railVal = lookupSymmetric(VERIFIED_RAIL_MINUTES, sidA, sidB);
        if (railVal != null) {
          rMinRow.push(railVal);
          rModeRow.push("🚄 KTX·ITX");
          tMinRow.push(railVal);
          tModeRow.push("🚄 KTX·ITX");
        } else {
          rMinRow.push(null);
          rModeRow.push(null);
          tMinRow.push(busVal);
          tModeRow.push(busLbl);
        }

        const directKey = `${sidA}-${sidB}`;
        const revKey = `${sidB}-${sidA}`;
        let fInfo = VERIFIED_DOMESTIC_FLIGHTS[directKey] || null;
        let depAirport = fInfo?.fromAirport;
        let arrAirport = fInfo?.toAirport;
        if (!fInfo && VERIFIED_DOMESTIC_FLIGHTS[revKey]) {
          fInfo = VERIFIED_DOMESTIC_FLIGHTS[revKey];
          depAirport = fInfo.toAirport;
          arrAirport = fInfo.fromAirport;
        }

        if (fInfo) {
          fMinRow.push(fInfo.flightMin + fInfo.accessMin);
          fModeRow.push(`✈️ 비행기 (${depAirport}→${arrAirport})`);
          fDetRow.push(
            `비행 ${formatDurationMinutes(fInfo.flightMin)} + 공항 이동 ${formatDurationMinutes(fInfo.accessMin)}`
          );
          fKmRow.push(haversineKm(stA.lat, stA.lon, stB.lat, stB.lon));
        } else {
          fMinRow.push(null);
          fModeRow.push(null);
          fDetRow.push(null);
          fKmRow.push(null);
        }
      }

      drivingMinutes.push(dMinRow);
      drivingKm.push(dKmRow);
      busMinutes.push(bMinRow);
      busModes.push(bModeRow);
      railMinutes.push(rMinRow);
      railModes.push(rModeRow);
      flightMinutes.push(fMinRow);
      flightModes.push(fModeRow);
      flightDetails.push(fDetRow);
      flightKm.push(fKmRow);
      transitMinutes.push(tMinRow);
      transitModes.push(tModeRow);
    }

    rm.multimodalVersion = 2;
    rm.drivingMinutes = drivingMinutes;
    rm.drivingKm = drivingKm;
    rm.busMinutes = busMinutes;
    rm.busModes = busModes;
    rm.railMinutes = railMinutes;
    rm.railModes = railModes;
    rm.flightMinutes = flightMinutes;
    rm.flightModes = flightModes;
    rm.flightDetails = flightDetails;
    rm.flightKm = flightKm;
    rm.transitMinutes = transitMinutes;
    rm.transitModes = transitModes;
    return rm;
  }

  /**
   * 두 지점 간 이동 소요시간(분), 거리(km), 이동수단 정보 조회
   * - 육지 ↔ 제주/서귀포 해상 구간은 선택한 수단과 무관하게 국내선 항공으로 자동 전환
   */
  function getTravelLeg(routingMatrix, fromStationId, toStationId, transportMode = "car", stations = null) {
    const ids = routingMatrix.stationIds;
    const i = ids.indexOf(fromStationId);
    const j = ids.indexOf(toStationId);
    if (i === -1 || j === -1) {
      return {
        minutes: 120,
        km: 140,
        modeType: "car",
        modeLabel: "🚗 자동차",
        detail: "도로 이동",
        autoSwitched: false,
        autoReason: null,
      };
    }

    const mode = transportMode === "transit" ? "rail" : transportMode || "car";
    if (i === j) {
      return {
        minutes: 0,
        km: 0,
        modeType: mode,
        modeLabel: "동일지점",
        detail: "출발지 인근 방문",
        autoSwitched: false,
        autoReason: null,
      };
    }

    const stA = stations ? stations.find((s) => s.id === fromStationId) : null;
    const stB = stations ? stations.find((s) => s.id === toStationId) : null;
    const isSeaCrossing =
      stA && stB ? stA.isIsland !== stB.isIsland : routingMatrix.drivingMinutes?.[i]?.[j] == null;

    if (isSeaCrossing) {
      return {
        minutes: routingMatrix.flightMinutes?.[i]?.[j] ?? routingMatrix.transitMinutes?.[i]?.[j] ?? 120,
        km: routingMatrix.flightKm?.[i]?.[j] ?? (stA && stB ? haversineKm(stA.lat, stA.lon, stB.lat, stB.lon) : 420),
        modeType: "flight",
        modeLabel: routingMatrix.flightModes?.[i]?.[j] || "✈️ 비행기",
        detail: routingMatrix.flightDetails?.[i]?.[j] || "국내선 항공 이동",
        autoSwitched: mode !== "flight",
        autoReason: mode !== "flight" ? "제주 해상 구간 · 항공 자동 전환" : null,
      };
    }

    const bothIsland = Boolean(stA && stB && stA.isIsland && stB.isIsland);
    const roadKm = routingMatrix.drivingKm?.[i]?.[j] ?? null;

    if (mode === "bus") {
      return {
        minutes: routingMatrix.busMinutes?.[i]?.[j] ?? routingMatrix.transitMinutes?.[i]?.[j] ?? 150,
        km: roadKm,
        modeType: "bus",
        modeLabel: routingMatrix.busModes?.[i]?.[j] || (bothIsland ? "🚌 공항리무진·급행버스" : "🚌 고속·시외버스"),
        detail: bothIsland
          ? `제주 시외·리무진 노선 기준${roadKm != null ? ` (${roadKm}km)` : ""}`
          : roadKm != null
          ? `고속·시외버스 도로 약 ${roadKm}km`
          : "고속·시외버스",
        autoSwitched: false,
        autoReason: null,
      };
    }

    if (mode === "rail") {
      if (routingMatrix.railMinutes?.[i]?.[j] != null) {
        return {
          minutes: routingMatrix.railMinutes[i][j],
          km: roadKm,
          modeType: "rail",
          modeLabel: routingMatrix.railModes?.[i]?.[j] || "🚄 KTX·ITX",
          detail: roadKm != null ? `코레일 공시 소요시간 기준 (${roadKm}km)` : "코레일 공시 소요시간 기준",
          autoSwitched: false,
          autoReason: null,
        };
      }
      return {
        minutes: routingMatrix.busMinutes?.[i]?.[j] ?? 150,
        km: roadKm,
        modeType: "bus",
        modeLabel: routingMatrix.busModes?.[i]?.[j] || (bothIsland ? "🚌 공항리무진·급행버스" : "🚌 고속·시외버스"),
        detail: bothIsland ? "제주 철도 없음 · 시외버스 연계" : "철도 미직통 구간 · 버스 연계",
        autoSwitched: true,
        autoReason: bothIsland ? "제주 철도 없음 · 버스 연계" : "철도 미직통 · 버스 연계",
      };
    }

    if (mode === "flight") {
      if (routingMatrix.flightMinutes?.[i]?.[j] != null) {
        return {
          minutes: routingMatrix.flightMinutes[i][j],
          km: routingMatrix.flightKm?.[i]?.[j] ?? roadKm,
          modeType: "flight",
          modeLabel: routingMatrix.flightModes?.[i]?.[j] || "✈️ 비행기",
          detail: routingMatrix.flightDetails?.[i]?.[j] || "국내선 직항 노선",
          autoSwitched: false,
          autoReason: null,
        };
      }
      if (routingMatrix.railMinutes?.[i]?.[j] != null) {
        return {
          minutes: routingMatrix.railMinutes[i][j],
          km: roadKm,
          modeType: "rail",
          modeLabel: routingMatrix.railModes?.[i]?.[j] || "🚄 KTX·ITX",
          detail: "국내선 미운항 구간 · KTX·ITX 연계",
          autoSwitched: true,
          autoReason: "국내선 미운항 · KTX 연계",
        };
      }
      return {
        minutes: routingMatrix.busMinutes?.[i]?.[j] ?? 150,
        km: roadKm,
        modeType: "bus",
        modeLabel: routingMatrix.busModes?.[i]?.[j] || (bothIsland ? "🚌 공항리무진·급행버스" : "🚌 고속·시외버스"),
        detail: bothIsland ? "제주 내부 구간 · 버스 이동" : "국내선 미운항 · 버스 연계",
        autoSwitched: true,
        autoReason: bothIsland ? "제주 내부 · 버스 이동" : "국내선 미운항 · 버스 연계",
      };
    }

    return {
      minutes: routingMatrix.drivingMinutes?.[i]?.[j] ?? 120,
      km: roadKm,
      modeType: "car",
      modeLabel: "🚗 자동차",
      detail: roadKm != null ? `도로 주행 약 ${roadKm}km` : "도로 주행",
      autoSwitched: false,
      autoReason: null,
    };
  }

  /**
   * 두 지점 구간에서 사용자가 직접 선택할 수 있는 유효 교통수단 목록 반환
   */
  function getAvailableModesForPair(data, fromStationId, toStationId) {
    if (!data || fromStationId === toStationId) return [];
    const rm = ensureMultimodalRouting(data);
    const ids = rm?.stationIds || [];
    const i = ids.indexOf(fromStationId);
    const j = ids.indexOf(toStationId);
    if (i === -1 || j === -1) return [];

    const stA = data.stations.find((s) => s.id === fromStationId);
    const stB = data.stations.find((s) => s.id === toStationId);
    if (stA && stB && stA.isIsland !== stB.isIsland) {
      return [{ modeType: "flight", chipLabel: "✈️ 비행기" }];
    }

    const bothIsland = Boolean(stA && stB && stA.isIsland && stB.isIsland);
    const modes = [
      { modeType: "car", chipLabel: "🚗 자동차" },
      { modeType: "bus", chipLabel: bothIsland ? "🚌 리무진·급행" : "🚌 고속버스" },
    ];
    if (rm.railMinutes?.[i]?.[j] != null) {
      modes.push({ modeType: "rail", chipLabel: "🚄 KTX·ITX" });
    }
    if (rm.flightMinutes?.[i]?.[j] != null) {
      modes.push({ modeType: "flight", chipLabel: "✈️ 비행기" });
    }
    return modes;
  }

  /**
   * 기능 2: 로드트립 경로 자동 추천 알고리즘 (발표자료 12p 구현)
   * - STEP 1: 출발지, 날짜 범위(시작일~종료일), 교통수단, 호우특보 지역 제외 여부 입력
   * - STEP 2: 여행 일자별 '개화 시작 ~ 만개' 단계인 지역 자동 필터링 (제주 출발 시 육지 포함 연계 추천)
   * - STEP 3: 남→북 개화 전선 및 이동시간을 함께 고려해 일자별 최적 동선 구성
   */
  function planRoadTrip(data, evaluations, params) {
    ensureMultimodalRouting(data);

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
    const tripYear = Number(startDate?.slice(0, 4) || 2027);
    const evalMap = Object.fromEntries(evaluations.map((e) => [e.station.id, e]));
    const originStation = data.stations.find((s) => s.id === originId) || data.stations[0];

    const visitedIds = new Set();
    const itinerary = [];
    let prevStationId = originId;
    let totalMinutes = 0;
    let totalKm = 0;
    let seaCrossCount = 0;

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

      const prevStation = evalMap[prevStationId]?.station || originStation;

      // 점수 계산: 만개(+35), 개화 시작(+25), 축제 기간 일치(+16), 남→북 진행 방향, 이동시간 패널티 + 왕복 바다 횡단 억제
      const scored = candidates.map((ev) => {
        const st = ev.station;
        const stStage = getStageOnDate(ev, currentDate);
        const leg = getTravelLeg(data.routingMatrix, prevStationId, st.id, transportMode, data.stations);
        const fest = st.festival;
        const isFestivalActive = fest
          ? tripYear === 2026
            ? currentDate >= fest.start && currentDate <= fest.end
            : currentDate >= ev.predictedOpenDate && currentDate <= addDaysIso(ev.predictedFullDate, 2)
          : false;
        const isFestivalEstimated = Boolean(isFestivalActive && tripYear >= 2027);

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

        // 이미 육지↔제주 항공을 1회 이용했다면 불필요한 반복 해상 횡단 방지
        if (prevStation.isIsland !== st.isIsland && seaCrossCount >= 1) {
          score -= 45;
        }

        return { ev, stStage, leg, isFestivalActive, isFestivalEstimated, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const picked = scored[0];

      if (prevStation.isIsland !== picked.ev.station.isIsland) {
        seaCrossCount += 1;
      }

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
        availableModes: getAvailableModesForPair(data, prevStation.id, picked.ev.station.id),
        userOverridden: false,
        isFestivalActive: picked.isFestivalActive,
        isFestivalEstimated: picked.isFestivalEstimated,
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
   * 추천된 일정의 특정 구간(dayIndex) 교통수단을 개별 변경하고 총 이동시간·거리 재계산
   */
  function updateTripLegMode(data, trip, dayIndex, newModeType) {
    if (!trip || !trip.itinerary || !trip.itinerary[dayIndex]) return trip;
    ensureMultimodalRouting(data);

    const day = trip.itinerary[dayIndex];
    day.leg = getTravelLeg(
      data.routingMatrix,
      day.fromStation.id,
      day.toStation.id,
      newModeType,
      data.stations
    );
    day.userOverridden = true;

    let totalMinutes = 0;
    let totalKm = 0;
    for (const item of trip.itinerary) {
      totalMinutes += item.leg?.minutes || 0;
      totalKm += item.leg?.km || 0;
    }
    trip.totalMinutes = totalMinutes;
    trip.totalKm = Number(totalKm.toFixed(1));
    return trip;
  }

  /**
   * 실측 일강수량 기반 강수 위험 경보 분석 (임의 시뮬레이션 값 미사용)
   * - Open-Meteo Archive 실측 일강수량 >= 30mm 또는 48시간 누적 >= 40mm 시 강수 주의 판정
   * - WAMIS 인근 하천 관측소 공식 홍수주의보 기준 수위 정보 병기
   */
  function evaluateWeatherHazards(data, targetDate) {
    const year = Number(targetDate?.slice(0, 4) || 2026);
    const yearSeriesMap =
      data.dailyByYear?.[String(year)] ||
      (year === 2027 ? data.daily2027 : data.daily2026) ||
      data.daily2026;
    const alerts = [];
    for (const st of data.stations) {
      const series = yearSeriesMap?.[st.id] || data.daily2026[st.id];
      const idx = series.findIndex((r) => r.date === targetDate);
      const dayRow = idx >= 0 ? series[idx] : series[series.length - 1];
      const prevRow = idx > 0 ? series[idx - 1] : dayRow;
      const rainTodayMm = Number((dayRow?.precip || 0).toFixed(1));
      const rain2DayMm = Number((rainTodayMm + (prevRow?.precip || 0)).toFixed(1));
      const dataType = dayRow?.dataType || (year <= 2026 ? "observed" : "climatology");
      const isLiveWeather = dataType === "observed" || dataType === "forecast16d";

      const activeAlert = isLiveWeather && (rainTodayMm >= 30.0 || rain2DayMm >= 40.0);

      alerts.push({
        station: st,
        date: targetDate,
        rainTodayMm,
        rain2DayMm,
        dataType,
        isLiveWeather,
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
    ensureMultimodalRouting,
    getTravelLeg,
    getAvailableModesForPair,
    planRoadTrip,
    updateTripLegMode,
    evaluateWeatherHazards,
  };
})(window);
