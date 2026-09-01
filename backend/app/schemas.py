from pydantic import BaseModel


class CurrentCongestion(BaseModel):
    observed_at: str
    congest_level: str
    population_avg: float


class CongestionHistoryPoint(BaseModel):
    observed_at: str
    population_avg: float


class DailyLogPoint(BaseModel):
    observed_at: str
    congest_level: str
    population_min: int
    population_max: int
    male_ppltn_rate: float | None = None
    female_ppltn_rate: float | None = None
    ppltn_rate_0: float | None = None
    ppltn_rate_10: float | None = None
    ppltn_rate_20: float | None = None
    ppltn_rate_30: float | None = None
    ppltn_rate_40: float | None = None
    ppltn_rate_50: float | None = None
    ppltn_rate_60: float | None = None
    ppltn_rate_70: float | None = None
    resnt_ppltn_rate: float | None = None
    non_resnt_ppltn_rate: float | None = None


class RawLogPoint(BaseModel):
    observed_at: str
    # Every field we kept for this reading, under the Seoul API's own key
    # names. Deliberately an open dict rather than named fields: pinning a
    # list here would mean editing this schema every time 서울시 adds a field,
    # and /congestion/daily/raw exists precisely to show everything we kept.
    fields: dict[str, str | int | float | None]


class MmcaRoomStatus(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None
    # None when there's no reading yet today — either a permanently-disabled
    # room with no collection history at all (see MMCA_DISABLED_SPACE_CODES),
    # or a normal room that just hasn't had its first poll of the day yet.
    observed_at: str | None


class MmcaDailyRoom(BaseModel):
    space_code: str
    space_nm: str | None
    congestion_nm: str | None


class MmcaDailyLogPoint(BaseModel):
    observed_at: str
    rooms: list[MmcaDailyRoom]


class MmcaPredictionPoint(BaseModel):
    # /mmca/daily 와 같은 형태 — 프론트가 minutesOfDay 를 그대로 재사용한다.
    observed_at: str
    # 0.0~3.0. 정수가 아닌 이유는 평행이동과 램프가 소수를 만들고, 차트의
    # yOf(tier) 가 이미 소수를 받기 때문이다.
    tier: float
    label: str


class MmcaRoomPrediction(BaseModel):
    space_code: str
    space_nm: str | None
    # 오늘 실측으로 곡선을 평행이동했는지. 미래 날짜와 개관 직후에는 False.
    anchored: bool
    # 14일 창 안에서 판독이 있는 날의 수. 방 단위이며 셀 단위가 아니다.
    sample_days: int
    points: list[MmcaPredictionPoint]


class MmcaExhibition(BaseModel):
    title: str
    # YYYY-MM-DD. 프론트는 점 표기로만 바꿔 그리므로 date 로 올릴 이유가 없다.
    start_date: str
    end_date: str
    # 이 전시가 쓰는 전시실. 전시실이 없는 공간(서울박스, 교육동 등)에서만
    # 열리는 전시는 비어 있고, 헤더 목록에만 실린다.
    space_codes: list[str]
