from datetime import date

from app.mmca_exhibitions import current_exhibitions

TODAY = date(2026, 9, 1)


def _page(*items: str) -> str:
    return f"<response><body><items>{''.join(items)}</items></body></response>"


def _item(title: str, venue: str, period: str, category: str = "현재전시") -> str:
    return (
        f"<item><title>{title}</title><venue>{venue}</venue>"
        f"<eventPeriod>{period}</eventPeriod><subjectCategory>{category}</subjectCategory></item>"
    )


def test_keeps_only_exhibitions_running_today():
    pages = [
        _page(
            _item("열린 전시", "서울", "2026-08-15~2026-10-25"),
            _item("끝난 전시", "서울", "2026-07-24~2026-08-02"),
            _item("아직 안 연 전시", "서울", "2026-10-01~2026-11-30"),
        )
    ]

    assert [e.title for e in current_exhibitions(pages, TODAY)["seoul"]] == ["열린 전시"]


def test_ignores_subject_category():
    # 같은 전시가 과거/현재/예정 세 값으로 중복 수록된다. 지금 열려 있는 전시가
    # '예정전시'로만 달려 있는 경우도 있어, 날짜만 보고 판정해야 한다.
    pages = [
        _page(
            _item("중복 전시", "서울", "2026-08-15~2026-10-25", "과거전시"),
            _item("중복 전시", "서울", "2026-08-15~2026-10-25", "현재전시"),
            _item("중복 전시", "서울", "2026-08-15~2026-10-25", "예정전시"),
            _item("예정으로만 달린 전시", "서울", "2026-04-20~2026-12-20", "예정전시"),
        )
    ]

    titles = {e.title for e in current_exhibitions(pages, TODAY)["seoul"]}
    assert titles == {"중복 전시", "예정으로만 달린 전시"}


def test_normalizes_titles_and_folds_near_duplicates():
    pages = [
        _page(
            # 제목에 이스케이프된 <br/> 이 섞여 오고, 콜론 앞 공백이 있는 판과
            # 없는 판이 함께 온다.
            _item("MMCA 해외 명작 : 수련", "과천", "2025-10-02~2027-01-03"),
            _item("MMCA 해외 명작: 수련", "과천", "2025-10-02~2027-01-03"),
            _item("상설전 &lt;br/&gt; (임시 휴관)", "과천", "2025-06-26~2027-06-27"),
            _item("상설전&lt;br/&gt;(임시 휴관)", "과천", "2025-06-26~2027-06-27"),
            # 옛 제목이 정식 제목의 앞부분으로 남아 있다.
            _item("이대원: 당신을 슬프게 하는 것은 하나도 없다", "덕수궁", "2026-08-06~2026-11-08"),
            _item("이대원", "덕수궁", "2026-08-06~2026-11-08"),
        )
    ]

    by_venue = current_exhibitions(pages, TODAY)
    assert [e.title for e in by_venue["gwacheon"]] == [
        "MMCA 해외 명작: 수련",
        "상설전 (임시 휴관)",
    ]
    assert [e.title for e in by_venue["deoksugung"]] == [
        "이대원: 당신을 슬프게 하는 것은 하나도 없다"
    ]


def test_maps_venues_and_drops_the_ones_we_have_no_page_for():
    pages = [
        _page(
            _item("서울 전시", "서울", "2026-01-01~2026-12-31"),
            _item("과천 전시", "과천", "2026-01-01~2026-12-31"),
            # 과천관 1층에 있다 — 과천 목록에 함께 실린다.
            _item("어린이 전시", "어린이미술관", "2026-01-01~2026-12-31"),
            _item("덕수궁 전시", "덕수궁", "2026-01-01~2026-12-31"),
            _item("청주 전시", "청주", "2026-01-01~2026-12-31"),
            _item("해외 전시", "해외", "2026-01-01~2026-12-31"),
        )
    ]

    by_venue = current_exhibitions(pages, TODAY)
    assert set(by_venue) == {"seoul", "gwacheon", "deoksugung"}
    assert [e.title for e in by_venue["seoul"]] == ["서울 전시"]
    assert {e.title for e in by_venue["gwacheon"]} == {"과천 전시", "어린이 전시"}
    assert [e.title for e in by_venue["deoksugung"]] == ["덕수궁 전시"]


def test_sorts_by_most_recently_opened():
    pages = [
        _page(
            _item("먼저 연 전시", "서울", "2026-01-01~2026-12-31"),
            _item("나중에 연 전시", "서울", "2026-08-27~2027-02-09"),
        )
    ]

    assert [e.title for e in current_exhibitions(pages, TODAY)["seoul"]] == [
        "나중에 연 전시",
        "먼저 연 전시",
    ]


def test_skips_rows_with_an_unparseable_period():
    pages = [
        _page(
            _item("기간 없음", "서울", ""),
            _item("기간 이상함", "서울", "상시"),
            _item("정상", "서울", "2026-01-01~2026-12-31"),
        )
    ]

    assert [e.title for e in current_exhibitions(pages, TODAY)["seoul"]] == ["정상"]
