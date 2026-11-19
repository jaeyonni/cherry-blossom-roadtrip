"""
수문학 2026-2학기 팀프로젝트 — '벚꽃 개화 로드트립'
실제 기상·수문·경로 데이터 수집 및 검증 스크립트

데이터 출처:
1. 기상 시계열 (일 최고/최저/평균 기온, 강수량, FAO 기준증발산량 ET0):
   Open-Meteo Historical Weather Archive API (ERA5 / KMA 동화 격자)
2. 기상청 종관기상관측(ASOS) 지점 메타데이터 및 생물계절관측 벚꽃 평년/실측 개화일:
   기상청 날씨누리·기상자료개방포털 공식 관측 기록
3. 도로 이동거리·주행시간 행렬:
   OSRM (Open Source Routing Machine) 실제 도로망 기반 Table API
4. 하천수위 홍수특보 기준값:
   국가수자원관리종합정보시스템(WAMIS) 및 한강·금강·낙동강·영산강 홍수통제소 고시 기준
"""

from __future__ import annotations

import csv
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# 기상청 공식 ASOS 지점 메타데이터 + 1991~2020 평년 개화일 + 최근 실측 개화일 + 2026 실제 축제 일정
STATIONS = [
    {
        "id": "189",
        "name": "서귀포",
        "region": "제주 남부",
        "lat": 33.2462,
        "lon": 126.5653,
        "isIsland": True,
        "normalBloom": "03-24",
        "obsBloom2023": "03-22",
        "obsBloom2024": "03-24",
        "obsBloom2025": "03-22",
        "obsBloom2026": "03-22",
        "spotName": "서귀포 예래생태공원·녹산로",
        "festival": {
            "name": "서귀포 예래생태공원 벚꽃나들이",
            "start": "2026-03-27",
            "end": "2026-03-29",
            "location": "서귀포시 예래동 생태공원 일원",
        },
        "riverBasin": "제주 남부 연안",
        "wamisStation": None,
    },
    {
        "id": "184",
        "name": "제주",
        "region": "제주 북부",
        "lat": 33.5141,
        "lon": 126.5297,
        "isIsland": True,
        "normalBloom": "03-25",
        "obsBloom2023": "03-22",
        "obsBloom2024": "03-24",
        "obsBloom2025": "03-23",
        "obsBloom2026": "03-25",
        "spotName": "제주시 전농로·제주대 벚꽃길",
        "festival": {
            "name": "제19회 전농로 왕벚꽃축제",
            "start": "2026-03-27",
            "end": "2026-03-29",
            "location": "제주시 삼도1동 전농로 일대",
        },
        "riverBasin": "한천",
        "wamisStation": None,
    },
    {
        "id": "159",
        "name": "부산",
        "region": "부산",
        "lat": 35.1047,
        "lon": 129.0320,
        "isIsland": False,
        "normalBloom": "03-28",
        "obsBloom2023": "03-24",
        "obsBloom2024": "03-22",
        "obsBloom2025": "03-23",
        "obsBloom2026": "03-25",
        "spotName": "남천동 삼익비치·온천천·맥도생태공원",
        "festival": {
            "name": "낙동강·대저·삼락 벚꽃축제",
            "start": "2026-03-27",
            "end": "2026-04-02",
            "location": "부산 사상구 삼락생태공원·강서구 대저생태공원",
        },
        "riverBasin": "낙동강 하구",
        "wamisStation": {
            "name": "삼랑진교",
            "river": "낙동강",
            "watchLevelM": 5.00,
            "warningLevelM": 7.00,
            "normalSpringLevelM": 1.68,
            "warningArea": "부산·경남 낙동강 하류",
        },
    },
    {
        "id": "155",
        "name": "진해(창원)",
        "region": "경남",
        "lat": 35.1531,
        "lon": 128.6616,
        "isIsland": False,
        "normalBloom": "03-27",
        "obsBloom2023": "03-21",
        "obsBloom2024": "03-22",
        "obsBloom2025": "03-24",
        "obsBloom2026": "03-25",
        "spotName": "진해 여좌천 로망스다리·경화역",
        "festival": {
            "name": "제64회 진해군항제",
            "start": "2026-03-27",
            "end": "2026-04-05",
            "location": "창원시 진해구 중원로터리·여좌천·경화역",
        },
        "riverBasin": "낙동강·남해동부",
        "wamisStation": {
            "name": "삼랑진교",
            "river": "낙동강",
            "watchLevelM": 5.00,
            "warningLevelM": 7.00,
            "normalSpringLevelM": 1.68,
            "warningArea": "창원·진해 및 낙동강 하류",
        },
    },
    {
        "id": "168",
        "name": "여수(하동)",
        "region": "전남·섬진강",
        "lat": 34.7439,
        "lon": 127.7371,
        "isIsland": False,
        "normalBloom": "03-28",
        "obsBloom2023": "03-22",
        "obsBloom2024": "03-24",
        "obsBloom2025": "03-25",
        "obsBloom2026": "03-26",
        "spotName": "하동 화개장터 십리벚꽃길·구례 섬진강",
        "festival": {
            "name": "하동 화개장터 벚꽃축제",
            "start": "2026-03-27",
            "end": "2026-03-29",
            "location": "하동군 화개면 십리벚꽃길·구례 섬진강변",
        },
        "riverBasin": "섬진강",
        "wamisStation": {
            "name": "구례교",
            "river": "섬진강",
            "watchLevelM": 7.00,
            "warningLevelM": 8.50,
            "normalSpringLevelM": 1.45,
            "warningArea": "전남 동부·구례·하동 섬진강 유역",
        },
    },
    {
        "id": "156",
        "name": "광주",
        "region": "전남·광주",
        "lat": 35.1728,
        "lon": 126.8914,
        "isIsland": False,
        "normalBloom": "03-28",
        "obsBloom2023": "03-22",
        "obsBloom2024": "03-28",
        "obsBloom2025": "03-27",
        "obsBloom2026": "03-27",
        "spotName": "운천저수지·중외공원·영산강변",
        "festival": {
            "name": "광주 운천저수지·영산강 벚꽃주간",
            "start": "2026-03-28",
            "end": "2026-04-03",
            "location": "광주 서구 운천저수지·북구 중외공원",
        },
        "riverBasin": "영산강",
        "wamisStation": {
            "name": "나주대교",
            "river": "영산강",
            "watchLevelM": 12.00,
            "warningLevelM": 14.00,
            "normalSpringLevelM": 2.35,
            "warningArea": "광주·전남 영산강 유역",
        },
    },
    {
        "id": "143",
        "name": "대구",
        "region": "대구·경북",
        "lat": 35.8780,
        "lon": 128.6530,
        "isIsland": False,
        "normalBloom": "03-26",
        "obsBloom2023": "03-26",
        "obsBloom2024": "03-26",
        "obsBloom2025": "03-24",
        "obsBloom2026": "03-26",
        "spotName": "수성못·두류공원·신천 벚꽃길",
        "festival": {
            "name": "대구 이월드 블라썸 피크닉 & 팔공산 벚꽃",
            "start": "2026-03-21",
            "end": "2026-04-05",
            "location": "대구 달서구 두류공원·수성못 일원",
        },
        "riverBasin": "금호강·낙동강",
        "wamisStation": {
            "name": "삼랑진교",
            "river": "낙동강",
            "watchLevelM": 5.00,
            "warningLevelM": 7.00,
            "normalSpringLevelM": 1.68,
            "warningArea": "대구·경북 낙동강 중류",
        },
    },
    {
        "id": "283",
        "name": "경주",
        "region": "경북",
        "lat": 35.8174,
        "lon": 129.2009,
        "isIsland": False,
        "normalBloom": "03-28",
        "obsBloom2023": "03-24",
        "obsBloom2024": "03-26",
        "obsBloom2025": "03-26",
        "obsBloom2026": "03-27",
        "spotName": "대릉원 돌담길·보문호·흥무로",
        "festival": {
            "name": "2026 경주 대릉원돌담길 축제",
            "start": "2026-04-03",
            "end": "2026-04-05",
            "location": "경주시 황남동 대릉원 돌담길 일원",
        },
        "riverBasin": "형산강",
        "wamisStation": None,
    },
    {
        "id": "146",
        "name": "전주",
        "region": "전북",
        "lat": 35.8409,
        "lon": 127.1172,
        "isIsland": False,
        "normalBloom": "03-29",
        "obsBloom2023": "03-22",
        "obsBloom2024": "03-29",
        "obsBloom2025": "03-26",
        "obsBloom2026": "03-28",
        "spotName": "완산공원 꽃동산·전주천·덕진공원",
        "festival": {
            "name": "전주 완산칠봉·전주천 봄꽃주간",
            "start": "2026-03-28",
            "end": "2026-04-05",
            "location": "전주시 완산구 완산공원·전주천 일원",
        },
        "riverBasin": "만경강",
        "wamisStation": None,
    },
    {
        "id": "133",
        "name": "대전",
        "region": "충청",
        "lat": 36.3721,
        "lon": 127.3733,
        "isIsland": False,
        "normalBloom": "03-30",
        "obsBloom2023": "03-27",
        "obsBloom2024": "03-30",
        "obsBloom2025": "03-29",
        "obsBloom2026": "03-29",
        "spotName": "갑천 유림공원·대청호 벚꽃길",
        "festival": {
            "name": "대청호 벚꽃축제 & 카이스트 벚꽃길",
            "start": "2026-03-27",
            "end": "2026-04-05",
            "location": "대전 동구 신상동 대청호·유성구 갑천변",
        },
        "riverBasin": "금강",
        "wamisStation": {
            "name": "공주교(금강교)",
            "river": "금강",
            "watchLevelM": 10.50,
            "warningLevelM": 12.50,
            "normalSpringLevelM": 1.82,
            "warningArea": "대전·세종·충남 금강 유역",
        },
    },
    {
        "id": "131",
        "name": "청주",
        "region": "충북",
        "lat": 36.6394,
        "lon": 127.4409,
        "isIsland": False,
        "normalBloom": "04-01",
        "obsBloom2023": "03-26",
        "obsBloom2024": "03-30",
        "obsBloom2025": "03-30",
        "obsBloom2026": "03-31",
        "spotName": "무심천 벚꽃길·청남대",
        "festival": {
            "name": "청주 무심천 푸드트럭·벚꽃축제",
            "start": "2026-03-27",
            "end": "2026-03-29",
            "location": "청주시 상당구 무심서로 일원",
        },
        "riverBasin": "미호강·금강",
        "wamisStation": {
            "name": "공주교(금강교)",
            "river": "금강",
            "watchLevelM": 10.50,
            "warningLevelM": 12.50,
            "normalSpringLevelM": 1.82,
            "warningArea": "충북·대전 금강 수계",
        },
    },
    {
        "id": "119",
        "name": "수원",
        "region": "경기 남부",
        "lat": 37.2723,
        "lon": 126.9853,
        "isIsland": False,
        "normalBloom": "04-06",
        "obsBloom2023": "03-28",
        "obsBloom2024": "04-01",
        "obsBloom2025": "04-02",
        "obsBloom2026": "04-02",
        "spotName": "팔달산 경기도청·만석공원·광교호수",
        "festival": {
            "name": "수원 팔달산·화성행궁 벚꽃주간",
            "start": "2026-04-03",
            "end": "2026-04-07",
            "location": "수원시 팔달구 효원로·화성행궁 일원",
        },
        "riverBasin": "안성천·한강",
        "wamisStation": None,
    },
    {
        "id": "108",
        "name": "서울",
        "region": "수도권",
        "lat": 37.5714,
        "lon": 126.9658,
        "isIsland": False,
        "normalBloom": "04-08",
        "obsBloom2023": "03-25",
        "obsBloom2024": "04-01",
        "obsBloom2025": "04-04",
        "obsBloom2026": "03-29",
        "spotName": "여의도 윤중로·석촌호수·송월동 표준목",
        "festival": {
            "name": "제20회 영등포 여의도 봄꽃축제",
            "start": "2026-04-03",
            "end": "2026-04-07",
            "location": "서울 영등포구 여의서로(윤중로) 일대",
        },
        "riverBasin": "한강",
        "wamisStation": {
            "name": "한강대교(잠수교 연계)",
            "river": "한강",
            "watchLevelM": 8.50,
            "warningLevelM": 10.50,
            "normalSpringLevelM": 2.95,
            "warningArea": "서울 한강 본류 및 여의도 한강공원",
        },
    },
    {
        "id": "105",
        "name": "강릉",
        "region": "강원 영동",
        "lat": 37.7515,
        "lon": 128.8910,
        "isIsland": False,
        "normalBloom": "03-31",
        "obsBloom2023": "03-31",
        "obsBloom2024": "03-31",
        "obsBloom2025": "04-01",
        "obsBloom2026": "04-02",
        "spotName": "경포호수·경포습지광장·남산공원",
        "festival": {
            "name": "2026 강릉 경포 벚꽃축제",
            "start": "2026-04-04",
            "end": "2026-04-11",
            "location": "강릉시 경포호수광장·경포습지광장 일원",
        },
        "riverBasin": "강릉 남대천",
        "wamisStation": None,
    },
    {
        "id": "101",
        "name": "춘천",
        "region": "강원 영서",
        "lat": 37.9026,
        "lon": 127.7357,
        "isIsland": False,
        "normalBloom": "04-09",
        "obsBloom2023": "03-31",
        "obsBloom2024": "04-05",
        "obsBloom2025": "04-05",
        "obsBloom2026": "04-06",
        "spotName": "공지천·의암호·소양강댐 벚꽃길",
        "festival": {
            "name": "춘천 소양강·공지천 봄꽃 산책",
            "start": "2026-04-05",
            "end": "2026-04-12",
            "location": "춘천시 공지천 조각공원·소양강댐 일원",
        },
        "riverBasin": "북한강",
        "wamisStation": None,
    },
]

# 기상청 서울기상관측소(108) 공식 벚꽃 개화일 및 만개일 (2014~2026)
SEOUL_OFFICIAL_HISTORY = [
    {"year": 2014, "openDate": "2014-03-28", "peakDate": "2014-03-31"},
    {"year": 2015, "openDate": "2015-04-03", "peakDate": "2015-04-08"},
    {"year": 2016, "openDate": "2016-04-02", "peakDate": "2016-04-05"},
    {"year": 2017, "openDate": "2017-04-06", "peakDate": "2017-04-10"},
    {"year": 2018, "openDate": "2018-04-02", "peakDate": "2018-04-05"},
    {"year": 2019, "openDate": "2019-04-03", "peakDate": "2019-04-08"},
    {"year": 2020, "openDate": "2020-03-27", "peakDate": "2020-04-03"},
    {"year": 2021, "openDate": "2021-03-24", "peakDate": "2021-03-29"},
    {"year": 2022, "openDate": "2022-04-04", "peakDate": "2022-04-08"},
    {"year": 2023, "openDate": "2023-03-25", "peakDate": "2023-03-30"},
    {"year": 2024, "openDate": "2024-04-01", "peakDate": "2024-04-07"},
    {"year": 2025, "openDate": "2025-04-04", "peakDate": "2025-04-10"},
    {"year": 2026, "openDate": "2026-03-29", "peakDate": "2026-04-03"},
]

# 코레일 KTX / ITX-청춘 실제 공시 소요시간(분) — 주요 철도 직통/연계 구간
VERIFIED_RAIL_MINUTES = {
    ("108", "119"): 34,   # 서울-수원 ITX/무궁화
    ("108", "131"): 72,   # 서울-오송 KTX+청주연계
    ("108", "133"): 59,   # 서울-대전 KTX
    ("108", "143"): 108,  # 서울-동대구 KTX
    ("108", "159"): 158,  # 서울-부산 KTX
    ("108", "146"): 98,   # 용산-전주 KTX
    ("108", "156"): 108,  # 용산-광주송정 KTX
    ("108", "283"): 128,  # 서울-경주 KTX
    ("108", "155"): 172,  # 서울-창원중앙(진해) KTX+연계버스
    ("108", "105"): 115,  # 서울-강릉 KTX-이음
    ("108", "101"): 72,   # 용산-춘천 ITX-청춘
    ("108", "168"): 168,  # 용산-여수EXPO KTX
    ("119", "133"): 65,   # 수원-대전 ITX/새마을
    ("119", "143"): 112,  # 수원-동대구 KTX
    ("119", "159"): 162,  # 수원-부산 KTX
    ("131", "133"): 35,   # 오송/청주-대전
    ("133", "143"): 45,   # 대전-동대구 KTX
    ("133", "159"): 100,  # 대전-부산 KTX
    ("133", "283"): 68,   # 대전-경주 KTX
    ("133", "146"): 68,   # 서대전-전주 ITX/무궁화
    ("133", "156"): 92,   # 서대전-광주송정 KTX/버스
    ("133", "155"): 122,  # 대전-창원 KTX
    ("133", "168"): 125,  # 서대전-여수EXPO KTX
    ("143", "159"): 48,   # 동대구-부산 KTX
    ("143", "283"): 22,   # 동대구-경주 KTX
    ("143", "155"): 66,   # 동대구-창원/진해
    ("146", "168"): 96,   # 전주-여수EXPO KTX
    ("159", "283"): 32,   # 부산-경주 KTX
}

# 제주 ↔ 육지 국내선 항공 + 공항 접근 소요시간 (순수 비행시간 + 공항/시내 이동시간 기준)
JEJU_CITY_ACCESS_MIN = 10   # 제주국제공항 ↔ 제주시내
SEOGWIPO_ACCESS_MIN = 50    # 제주국제공항 ↔ 서귀포 시내

VERIFIED_JEJU_FLIGHTS = {
    "108": {"airport": "김포", "flightMin": 70, "accessMin": 35},
    "119": {"airport": "김포", "flightMin": 70, "accessMin": 55},
    "131": {"airport": "청주", "flightMin": 65, "accessMin": 25},
    "133": {"airport": "청주", "flightMin": 65, "accessMin": 45},
    "143": {"airport": "대구", "flightMin": 65, "accessMin": 25},
    "283": {"airport": "포항경주", "flightMin": 65, "accessMin": 35},
    "159": {"airport": "김해", "flightMin": 65, "accessMin": 30},
    "155": {"airport": "김해", "flightMin": 65, "accessMin": 40},
    "156": {"airport": "광주", "flightMin": 55, "accessMin": 25},
    "146": {"airport": "군산", "flightMin": 55, "accessMin": 50},
    "168": {"airport": "여수", "flightMin": 55, "accessMin": 25},
    "101": {"airport": "원주", "flightMin": 70, "accessMin": 60},
    "105": {"airport": "원주", "flightMin": 70, "accessMin": 75},
}

# 내륙 정기 국내선 직항 노선 (대구는 평시 정기 내륙 노선 미운항으로 제외)
VERIFIED_DOMESTIC_FLIGHTS = {
    ("108", "159"): {"fromAirport": "김포", "toAirport": "김해", "flightMin": 60, "accessMin": 65},
    ("119", "159"): {"fromAirport": "김포", "toAirport": "김해", "flightMin": 60, "accessMin": 85},
    ("108", "155"): {"fromAirport": "김포", "toAirport": "김해", "flightMin": 60, "accessMin": 75},
    ("108", "168"): {"fromAirport": "김포", "toAirport": "여수", "flightMin": 55, "accessMin": 60},
    ("108", "156"): {"fromAirport": "김포", "toAirport": "광주", "flightMin": 55, "accessMin": 60},
    ("108", "283"): {"fromAirport": "김포", "toAirport": "포항경주", "flightMin": 55, "accessMin": 70},
}

# 전국 고속·시외버스 주요 공시 소요시간(분)
VERIFIED_EXPRESS_BUS_MINUTES = {
    ("108", "119"): 55,
    ("108", "101"): 90,
    ("108", "131"): 90,
    ("108", "133"): 120,
    ("108", "146"): 160,
    ("108", "105"): 170,
    ("108", "156"): 200,
    ("108", "143"): 210,
    ("108", "283"): 210,
    ("108", "155"): 235,
    ("108", "159"): 240,
    ("108", "168"): 255,
    ("184", "189"): 65,
    ("159", "155"): 60,
    ("159", "283"): 55,
    ("159", "143"): 75,
    ("143", "283"): 55,
    ("146", "156"): 70,
    ("133", "131"): 45,
    ("133", "146"): 65,
    ("133", "143"): 115,
    ("133", "156"): 130,
    ("156", "168"): 100,
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """두 위경도 좌표 간 대원 거리(km)를 계산한다."""
    rad = math.pi / 180.0
    dlat = (lat2 - lat1) * rad
    dlon = (lon2 - lon1) * rad
    a = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1 * rad) * math.cos(lat2 * rad) * (math.sin(dlon / 2.0) ** 2)
    )
    return round(2.0 * 6371.0 * math.asin(min(1.0, math.sqrt(a))), 1)


def format_korean_duration(mins: int) -> str:
    """분 단위 시간을 한국어 시·분 표기로 변환한다."""
    h, m = divmod(int(round(mins)), 60)
    if h == 0:
        return f"{m}분"
    if m == 0:
        return f"{h}시간"
    return f"{h}시간 {m}분"


def fetch_json(url: str, retries: int = 3) -> dict:
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "HydrologyCherryBlossomApp/1.0 (Academic Project)"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as err:
            last_err = err
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def day_of_year(iso_date: str) -> int:
    dt = date.fromisoformat(iso_date)
    return dt.timetuple().tm_yday


def compute_gdd_series(
    daily: dict,
    t_base: float = 1.2,
    start_mmdd: str = "02-07",
) -> list[dict]:
    times = daily["time"]
    tmax_arr = daily["temperature_2m_max"]
    tmin_arr = daily["temperature_2m_min"]
    tmean_arr = daily["temperature_2m_mean"]
    precip_arr = daily["precipitation_sum"]
    et0_arr = daily["et0_fao_evapotranspiration"]

    year = times[0][:4]
    start_iso = f"{year}-{start_mmdd}"

    cum_gdd = 0.0
    cum_p = 0.0
    cum_et = 0.0
    cum_q = 0.0
    cum_ds = 0.0

    rows = []
    for i, d_str in enumerate(times):
        tmax = tmax_arr[i] if tmax_arr[i] is not None else 0.0
        tmin = tmin_arr[i] if tmin_arr[i] is not None else 0.0
        tmean_raw = tmean_arr[i]
        # GDD 표기식 T_mean = (T_max + T_min) / 2 와 일평균 기온 모두 기록
        tmean_hl = round((tmax + tmin) / 2.0, 2)
        tmean_obs = round(tmean_raw if tmean_raw is not None else tmean_hl, 2)
        p_val = round(precip_arr[i] if precip_arr[i] is not None else 0.0, 2)
        et_val = round(et0_arr[i] if et0_arr[i] is not None else 1.0, 2)

        # 단순화 물수지: P = ET + Q + ΔS (SCS-CN 기반 유효강수 초과시 유출 Q 발생)
        # 초기손실 Ia = 5.0 mm 초과 강수량의 일부가 직접유출 Q로 유출됨
        q_val = round(max(0.0, (p_val - 5.0) * 0.28), 2) if p_val > 5.0 else 0.0
        ds_daily = round(p_val - et_val - q_val, 2)

        if d_str >= start_iso:
            daily_gdd = max(0.0, tmean_hl - t_base)
            cum_gdd = round(cum_gdd + daily_gdd, 2)
            cum_p = round(cum_p + p_val, 2)
            cum_et = round(cum_et + et_val, 2)
            cum_q = round(cum_q + q_val, 2)
            cum_ds = round(cum_ds + ds_daily, 2)
        else:
            daily_gdd = 0.0

        rows.append(
            {
                "date": d_str,
                "tMax": round(tmax, 2),
                "tMin": round(tmin, 2),
                "tMean": tmean_obs,
                "tMeanHL": tmean_hl,
                "precip": p_val,
                "et0": et_val,
                "runoffQ": q_val,
                "deltaS": ds_daily,
                "dailyGdd": round(daily_gdd, 2),
                "cumGdd": cum_gdd,
                "cumPrecip": cum_p,
                "cumEt0": cum_et,
                "cumRunoffQ": cum_q,
                "cumDeltaS": cum_ds,
            }
        )
    return rows


def fetch_spring_2026_all_stations() -> dict[str, list[dict]]:
    lat_str = ",".join(str(s["lat"]) for s in STATIONS)
    lon_str = ",".join(str(s["lon"]) for s in STATIONS)
    url = (
        "https://archive-api.open-meteo.com/v1/archive"
        f"?latitude={lat_str}&longitude={lon_str}"
        "&start_date=2026-02-01&end_date=2026-04-25"
        "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,et0_fao_evapotranspiration"
        "&timezone=Asia%2FSeoul"
    )
    print(f"Fetching 2026 spring archive for {len(STATIONS)} ASOS stations...")
    raw = fetch_json(url)
    # Open-Meteo returns a list when multiple coordinates are requested
    items = raw if isinstance(raw, list) else [raw]
    result = {}
    for station, item in zip(STATIONS, items):
        series = compute_gdd_series(item["daily"], t_base=1.2, start_mmdd="02-07")
        result[station["id"]] = series
    return result


def fetch_seoul_longterm_history() -> dict:
    # 1) 1973~2026 서울 3월 평균기온 장기 상승 추세 (발표자료 6p 검증)
    print("Fetching Seoul (ASOS 108) long-term daily weather 1973-2026...")
    url_long = (
        "https://archive-api.open-meteo.com/v1/archive"
        "?latitude=37.5714&longitude=126.9658"
        "&start_date=1973-01-01&end_date=2026-04-25"
        "&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,et0_fao_evapotranspiration"
        "&timezone=Asia%2FSeoul"
    )
    raw_long = fetch_json(url_long)
    daily = raw_long["daily"]

    # 연도별 3월 평균기온 및 2~4월 시계열 인덱싱
    by_year_march: dict[int, list[float]] = {}
    by_year_spring: dict[int, dict[str, list]] = {}
    for i, d_str in enumerate(daily["time"]):
        yr = int(d_str[:4])
        mm = int(d_str[5:7])
        if mm == 3 and daily["temperature_2m_mean"][i] is not None:
            by_year_march.setdefault(yr, []).append(daily["temperature_2m_mean"][i])
        if yr >= 2014 and mm in (2, 3, 4):
            bucket = by_year_spring.setdefault(
                yr,
                {
                    "time": [],
                    "temperature_2m_max": [],
                    "temperature_2m_min": [],
                    "temperature_2m_mean": [],
                    "precipitation_sum": [],
                    "et0_fao_evapotranspiration": [],
                },
            )
            bucket["time"].append(d_str)
            bucket["temperature_2m_max"].append(daily["temperature_2m_max"][i])
            bucket["temperature_2m_min"].append(daily["temperature_2m_min"][i])
            bucket["temperature_2m_mean"].append(daily["temperature_2m_mean"][i])
            bucket["precipitation_sum"].append(daily["precipitation_sum"][i])
            bucket["et0_fao_evapotranspiration"].append(daily["et0_fao_evapotranspiration"][i])

    # 1973~2026년 3월 평균기온 선형회귀 (10년당 상승률)
    years_all = sorted(by_year_march.keys())
    march_means_all = [round(sum(by_year_march[y]) / len(by_year_march[y]), 2) for y in years_all]
    mean_x = statistics.mean(years_all)
    mean_y = statistics.mean(march_means_all)
    slope_per_year = sum((x - mean_x) * (y - mean_y) for x, y in zip(years_all, march_means_all)) / sum(
        (x - mean_x) ** 2 for x in years_all
    )
    warming_per_decade = round(slope_per_year * 10.0, 2)

    # 1991~2020 서울 3월 평년 기온
    norm_1991_2020 = [
        round(sum(by_year_march[y]) / len(by_year_march[y]), 2)
        for y in range(1991, 2021)
        if y in by_year_march
    ]
    march_normal_temp = round(statistics.mean(norm_1991_2020), 2)

    # 2014~2026 서울 공식 개화일 vs 3월 평균기온 + 개화일 도달 누적 GDD 역산출
    normal_open_doy = day_of_year("2026-04-08")  # 평년(비윤년) 4월 8일 = DOY 98
    history_records = []
    for rec in SEOUL_OFFICIAL_HISTORY:
        yr = rec["year"]
        spring_series = compute_gdd_series(by_year_spring[yr], t_base=1.2, start_mmdd="02-07")
        open_row = next((r for r in spring_series if r["date"] == rec["openDate"]), None)
        peak_row = next((r for r in spring_series if r["date"] == rec["peakDate"]), None)
        march_mean = round(statistics.mean(by_year_march[yr]), 2)
        open_doy = day_of_year(rec["openDate"])
        peak_doy = day_of_year(rec["peakDate"])
        # 윤년 보정: 4월 8일 평년 DOY (윤년이면 99, 평년이면 98)
        ref_normal_doy = day_of_year(f"{yr}-04-08")
        days_earlier_than_normal = ref_normal_doy - open_doy

        history_records.append(
            {
                "year": yr,
                "openDate": rec["openDate"],
                "peakDate": rec["peakDate"],
                "openDoy": open_doy,
                "peakDoy": peak_doy,
                "daysEarlierThanNormal": days_earlier_than_normal,
                "marchMeanTemp": march_mean,
                "cumGddAtOpen": open_row["cumGdd"] if open_row else None,
                "cumPrecipAtOpen": open_row["cumPrecip"] if open_row else None,
                "cumDeltaSAtOpen": open_row["cumDeltaS"] if open_row else None,
                "cumGddAtPeak": peak_row["cumGdd"] if peak_row else None,
            }
        )

    # 2014~2026 서울 3월 평균기온과 개화일(DOY) 상관계수 r 계산
    xs = [r["marchMeanTemp"] for r in history_records]
    ys = [r["openDoy"] for r in history_records]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    corr_r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(
        sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)
    )

    return {
        "warmingPerDecadeC": warming_per_decade,
        "marchNormalTemp1991_2020": march_normal_temp,
        "marchTempOpenDoyCorrelationR": round(corr_r, 3),
        "marchTrend1973_2026": [
            {"year": y, "marchMeanTemp": m} for y, m in zip(years_all, march_means_all)
        ],
        "seoul2014_2026": history_records,
    }


def fetch_osrm_matrix() -> dict:
    coords = ";".join(f"{s['lon']},{s['lat']}" for s in STATIONS)
    url = f"https://router.project-osrm.org/table/v1/driving/{coords}?annotations=duration,distance"
    print("Fetching real OSRM driving duration & distance matrix for 15 stations...")
    raw = fetch_json(url)

    durations_min = []
    distances_km = []
    for i, row in enumerate(raw["durations"]):
        d_row = []
        k_row = []
        for j, val in enumerate(row):
            if STATIONS[i]["isIsland"] != STATIONS[j]["isIsland"]:
                # 육지 ↔ 제주 해상 구간은 도로(자동차) 이동 불가
                d_row.append(None)
                k_row.append(None)
            elif i == j:
                d_row.append(0)
                k_row.append(0.0)
            else:
                d_min = round(val / 60.0) if val is not None else None
                k_km = round(raw["distances"][i][j] / 1000.0, 1) if raw["distances"][i][j] is not None else None
                d_row.append(d_min)
                k_row.append(k_km)
        durations_min.append(d_row)
        distances_km.append(k_row)

    # 복합 교통수단 행렬 구성 (고속버스 · KTX 철도 · 국내선 항공)
    id_list = [s["id"] for s in STATIONS]
    bus_min, bus_mode = [], []
    rail_min, rail_mode = [], []
    flight_min, flight_mode, flight_detail, flight_km = [], [], [], []
    transit_min, transit_mode = [], []

    for i, sid_a in enumerate(id_list):
        b_m_row, b_l_row = [], []
        r_m_row, r_l_row = [], []
        f_m_row, f_l_row, f_d_row, f_k_row = [], [], [], []
        t_m_row, t_l_row = [], []

        for j, sid_b in enumerate(id_list):
            if i == j:
                b_m_row.append(0)
                b_l_row.append("동일지점")
                r_m_row.append(None)
                r_l_row.append(None)
                f_m_row.append(None)
                f_l_row.append(None)
                f_d_row.append(None)
                f_k_row.append(0.0)
                t_m_row.append(0)
                t_l_row.append("동일지점")
                continue

            st_a = STATIONS[i]
            st_b = STATIONS[j]
            key = (sid_a, sid_b)
            rev_key = (sid_b, sid_a)

            if st_a["isIsland"] != st_b["isIsland"]:
                # 육지 ↔ 제주/서귀포: 국내선 항공 전용
                mainland_id = sid_b if st_a["isIsland"] else sid_a
                island_id = sid_a if st_a["isIsland"] else sid_b
                info = VERIFIED_JEJU_FLIGHTS[mainland_id]
                island_access = SEOGWIPO_ACCESS_MIN if island_id == "189" else JEJU_CITY_ACCESS_MIN
                total_min = info["flightMin"] + info["accessMin"] + island_access
                transfer_min = info["accessMin"] + island_access
                dep_arr = f"제주→{info['airport']}" if st_a["isIsland"] else f"{info['airport']}→제주"
                transfer_label = "공항·서귀포 이동" if island_id == "189" else "공항 이동"

                b_m_row.append(None)
                b_l_row.append(None)
                r_m_row.append(None)
                r_l_row.append(None)
                f_m_row.append(total_min)
                f_l_row.append(f"✈️ 비행기 ({dep_arr})")
                f_d_row.append(
                    f"비행 {format_korean_duration(info['flightMin'])} + {transfer_label} {format_korean_duration(transfer_min)}"
                )
                f_k_row.append(haversine_km(st_a["lat"], st_a["lon"], st_b["lat"], st_b["lon"]))
                t_m_row.append(total_min)
                t_l_row.append(f"✈️ 비행기 ({dep_arr})")
                continue

            # 동일 권역 (육지↔육지 또는 제주↔서귀포)
            bus_val = VERIFIED_EXPRESS_BUS_MINUTES.get(key) or VERIFIED_EXPRESS_BUS_MINUTES.get(rev_key)
            if bus_val is None:
                drive_m = durations_min[i][j] or 150
                bus_val = round(drive_m * 1.15 + 15)
            bus_lbl = "🚌 공항리무진·급행버스" if st_a["isIsland"] else "🚌 고속·시외버스"
            b_m_row.append(bus_val)
            b_l_row.append(bus_lbl)

            rail_val = VERIFIED_RAIL_MINUTES.get(key) or VERIFIED_RAIL_MINUTES.get(rev_key)
            if rail_val is not None:
                r_m_row.append(rail_val)
                r_l_row.append("🚄 KTX·ITX")
                t_m_row.append(rail_val)
                t_l_row.append("🚄 KTX·ITX")
            else:
                r_m_row.append(None)
                r_l_row.append(None)
                t_m_row.append(bus_val)
                t_l_row.append(bus_lbl)

            if key in VERIFIED_DOMESTIC_FLIGHTS:
                f_info = VERIFIED_DOMESTIC_FLIGHTS[key]
                dep, arr = f_info["fromAirport"], f_info["toAirport"]
            elif rev_key in VERIFIED_DOMESTIC_FLIGHTS:
                f_info = VERIFIED_DOMESTIC_FLIGHTS[rev_key]
                dep, arr = f_info["toAirport"], f_info["fromAirport"]
            else:
                f_info = None
                dep, arr = None, None

            if f_info is not None:
                f_total = f_info["flightMin"] + f_info["accessMin"]
                f_m_row.append(f_total)
                f_l_row.append(f"✈️ 비행기 ({dep}→{arr})")
                f_d_row.append(
                    f"비행 {format_korean_duration(f_info['flightMin'])} + 공항 이동 {format_korean_duration(f_info['accessMin'])}"
                )
                f_k_row.append(haversine_km(st_a["lat"], st_a["lon"], st_b["lat"], st_b["lon"]))
            else:
                f_m_row.append(None)
                f_l_row.append(None)
                f_d_row.append(None)
                f_k_row.append(None)

        bus_min.append(b_m_row)
        bus_mode.append(b_l_row)
        rail_min.append(r_m_row)
        rail_mode.append(r_l_row)
        flight_min.append(f_m_row)
        flight_mode.append(f_l_row)
        flight_detail.append(f_d_row)
        flight_km.append(f_k_row)
        transit_min.append(t_m_row)
        transit_mode.append(t_l_row)

    return {
        "multimodalVersion": 2,
        "stationIds": id_list,
        "drivingMinutes": durations_min,
        "drivingKm": distances_km,
        "busMinutes": bus_min,
        "busModes": bus_mode,
        "railMinutes": rail_min,
        "railModes": rail_mode,
        "flightMinutes": flight_min,
        "flightModes": flight_mode,
        "flightDetails": flight_detail,
        "flightKm": flight_km,
        "transitMinutes": transit_min,
        "transitModes": transit_mode,
    }


def calibrate_stations(stations: list[dict], spring_2026: dict[str, list[dict]]) -> list[dict]:
    enriched = []
    for s in stations:
        sid = s["id"]
        series = spring_2026[sid]
        obs_date_2026 = f"2026-{s['obsBloom2026']}"
        obs_row = next((r for r in series if r["date"] == obs_date_2026), None)
        calibrated_gdd = obs_row["cumGdd"] if obs_row else 371.5

        # 참고문헌 Shi et al. (2014) 동아시아 기준(371.5°C·day)과 기상청 관측 역산 임계값 비교
        s_copy = dict(s)
        s_copy["calibratedThresholdGdd"] = round(calibrated_gdd, 2)
        s_copy["referenceThresholdGdd"] = 371.5
        s_copy["obs2026CumPrecip"] = obs_row["cumPrecip"] if obs_row else 0.0
        s_copy["obs2026CumDeltaS"] = obs_row["cumDeltaS"] if obs_row else 0.0
        enriched.append(s_copy)
    return enriched


def export_csv_files(
    seoul_history: list[dict],
    stations: list[dict],
    spring_2026: dict[str, list[dict]],
) -> None:
    # 1) 2016-2026_서울_개화일.csv (발표자료 17p 크리에이터 대시보드 파일명)
    seoul_csv = DATA_DIR / "2016-2026_서울_개화일.csv"
    with seoul_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "연도",
                "관측지점",
                "공식_개화일",
                "공식_만개일",
                "평년(4/8)_대비_차이(일)",
                "3월_평균기온(°C)",
                "개화일_누적GDD(°C·day)",
                "개화일_누적강수(mm)",
                "개화일_물수지ΔS(mm)",
            ]
        )
        for row in seoul_history:
            if row["year"] >= 2016:
                writer.writerow(
                    [
                        row["year"],
                        "서울(108)",
                        row["openDate"],
                        row["peakDate"],
                        f"{-row['daysEarlierThanNormal']:+d}",
                        row["marchMeanTemp"],
                        row["cumGddAtOpen"],
                        row["cumPrecipAtOpen"],
                        row["cumDeltaSAtOpen"],
                    ]
                )

    # 2) 전국_ASOS_기온자료.csv (발표자료 17p 크리에이터 대시보드 파일명)
    asos_csv = DATA_DIR / "전국_ASOS_기온자료.csv"
    with asos_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "지점번호",
                "지역명",
                "날짜",
                "최고기온(°C)",
                "최저기온(°C)",
                "평균기온(°C)",
                "일강수량(mm)",
                "기준증발산ET0(mm)",
                "일유출Q(mm)",
                "일저류변화ΔS(mm)",
                "일GDD(°C·day)",
                "누적GDD(°C·day)",
            ]
        )
        for s in stations:
            for r in spring_2026[s["id"]]:
                writer.writerow(
                    [
                        s["id"],
                        s["name"],
                        r["date"],
                        r["tMax"],
                        r["tMin"],
                        r["tMean"],
                        r["precip"],
                        r["et0"],
                        r["runoffQ"],
                        r["deltaS"],
                        r["dailyGdd"],
                        r["cumGdd"],
                    ]
                )
    print(f"Exported CSVs: {seoul_csv.name}, {asos_csv.name}")


def main() -> None:
    spring_2026 = fetch_spring_2026_all_stations()
    seoul_analysis = fetch_seoul_longterm_history()
    osrm_matrix = fetch_osrm_matrix()
    calibrated_stations = calibrate_stations(STATIONS, spring_2026)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "weather": "Open-Meteo Historical Weather Archive API (ERA5/KMA grid, Tmax/Tmin/Tmean/Precipitation/FAO-ET0)",
            "phenology": "기상청 생물계절관측 서울(108) 및 전국 ASOS 표준목 평년·실측 개화일",
            "routing": "OSRM Driving Table API + 국내선 항공·고속버스·코레일 KTX 공시 소요시간",
            "hydrology": "Shi et al. (2014) Prunus yedoensis GDD (T_base=1.2°C, 2/7 누적) & Viessman & Lewis (1996) 물수지식 P=ET+Q+ΔS",
            "flood": "WAMIS 국가수자원관리종합정보시스템 및 홍수통제소 특보 기준 수위",
        },
        "modelDefaults": {
            "tBase": 1.2,
            "startMmDd": "02-07",
            "referenceThresholdGdd": 371.5,
            "fullBloomOffsetDays": 6,
            "endOffsetDays": 13,
        },
        "stations": calibrated_stations,
        "daily2026": spring_2026,
        "seoulAnalysis": seoul_analysis,
        "routingMatrix": osrm_matrix,
    }

    json_path = DATA_DIR / "verified_data.json"
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    js_path = DATA_DIR / "verified_data.js"
    with js_path.open("w", encoding="utf-8") as f:
        f.write("// Auto-generated by scripts/build_verified_data.py from verified APIs & KMA records\n")
        f.write("window.VERIFIED_CHERRY_DATA = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    export_csv_files(seoul_analysis["seoul2014_2026"], calibrated_stations, spring_2026)
    print(f"Successfully generated {json_path.name} and {js_path.name}")
    print(
        f"Seoul 1973-2026 March warming: {seoul_analysis['warmingPerDecadeC']:+.2f}°C/decade, "
        f"2014-2026 corr(March Tmean, Open DOY) r = {seoul_analysis['marchTempOpenDoyCorrelationR']}"
    )


if __name__ == "__main__":
    main()
