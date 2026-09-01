from app.mmca_exhibitions import current_exhibitions, space_codes


def _row(title: str, venue: str, place_detail: str, start: str = "2026-01-01", end: str = "2026-12-31") -> dict:
    return {
        "exhTitle": title,
        "exhPlaNm": venue,
        "exhPlaDtl": place_detail,
        "exhStDt": start,
        "exhEdDt": end,
    }


def test_reads_room_numbers_listed_before_전시실():
    assert space_codes("seoul", "지하1층 3,4,5 전시실 / 2층 MMCA 스튜디오") == [
        "MMCA-SPACE-1003",
        "MMCA-SPACE-1004",
        "MMCA-SPACE-1005",
    ]
    assert space_codes("seoul", "1층, 1전시실 / 지하1층, 2전시실") == [
        "MMCA-SPACE-1001",
        "MMCA-SPACE-1002",
    ]
    assert space_codes("gwacheon", "1층,  1, 2 전시실, 중앙홀 및 조각공원") == [
        "MMCA-SPACE-2001",
        "MMCA-SPACE-2002",
    ]


def test_does_not_mistake_a_floor_number_for_a_room_number():
    # "지하1층"의 1, "3층"의 5 앞의 3 — 뒤에 "층"이 오는 숫자는 방이 아니다.
    assert space_codes("gwacheon", "3층, 5, 6전시실") == [
        "MMCA-SPACE-2005",
        "MMCA-SPACE-2006",
    ]
    assert space_codes("seoul", "지하1층, 서울박스") == []
    assert space_codes("seoul", "교육동 2층") == []


def test_reads_the_circular_room_as_its_own_room():
    assert space_codes("gwacheon", "1층, 1원형전시실") == ["MMCA-SPACE-2007"]
    # 2원형전시실은 우리가 혼잡도를 수집하는 방이 아니다. "2전시실"로
    # 오인해서는 안 되고, 그냥 빠져야 한다.
    assert space_codes("gwacheon", "2원형전시실, 3층회랑 브릿지, 로비") == []


def test_drops_rooms_the_venue_does_not_have():
    # 덕수궁은 MMCA-SPACE-4001("1전시실") 하나만 수집한다.
    assert space_codes("deoksugung", "1, 2, 3, 4전시실") == ["MMCA-SPACE-4001"]


def test_groups_by_venue_and_drops_venues_we_have_no_page_for():
    rows = [
        _row("서울 전시", "서울", "지하1층 6, 7전시실"),
        _row("과천 전시", "과천", "2층, 3, 4 전시실"),
        # 과천관 1층에 있다 — 과천 목록에 함께 실린다. 전시실 표기는 비어 있다.
        _row("어린이 전시", "어린이미술관", ""),
        _row("덕수궁 전시", "덕수궁", "1, 2, 3, 4전시실"),
        _row("청주 전시", "청주", "5층, 기획전시실"),
    ]

    by_venue = current_exhibitions(rows)

    assert set(by_venue) == {"seoul", "gwacheon", "deoksugung"}
    assert [e.title for e in by_venue["gwacheon"]] == ["과천 전시", "어린이 전시"]
    assert by_venue["seoul"][0].space_codes == ["MMCA-SPACE-1006", "MMCA-SPACE-1007"]
    assert by_venue["gwacheon"][1].space_codes == []


def test_keeps_the_period_and_the_site_order():
    rows = [
        _row("나중에 연 전시", "서울", "", start="2026-08-27", end="2027-02-09"),
        _row("먼저 연 전시", "서울", "", start="2026-04-01", end="2026-12-06"),
    ]

    seoul = current_exhibitions(rows)["seoul"]
    assert [e.title for e in seoul] == ["나중에 연 전시", "먼저 연 전시"]
    assert (seoul[0].start_date, seoul[0].end_date) == ("2026-08-27", "2027-02-09")


def test_skips_rows_without_a_title():
    assert current_exhibitions([_row("", "서울", "1전시실")])["seoul"] == []
