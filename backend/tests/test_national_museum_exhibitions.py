from app.national_museum_exhibitions import current_exhibitions

# 누리집 "현재 전시" 목록에서 그대로 떠 온 세 건이다. 손으로 줄인 마크업이
# 아니라 실제 응답이어야, 누리집이 개편되면 이 테스트가 먼저 깨진다.
LIST_HTML = """
<div class="info">
    <div class="mt20 mb10">
    <span class="label-type purple-2">현재전시</span>
    <span class="label-type purple-2">특별전</span>
    </div>
    <a href="?schM=view&menuId=current&exhiSpThemId=3529713&listType=list">
    <strong>우리들의 밥상</strong>
    </a>
    <ul class="info-list special">
    <li><strong>기간</strong>
    <p>2026-07-01~2026-10-25</p></li>
    <li><strong>장소</strong>
    <p>국립중앙박물관 특별전시실 2</p></li>
    </ul>
<div class="info">
    <div class="mt20 mb10">
    <span class="label-type purple-2">현재전시</span>
    <span class="label-type purple-2">특별전</span>
    </div>
    <a href="?schM=view&menuId=current&exhiSpThemId=3549792&listType=list">
    <strong>[지역 공립박물관 순회전시] 국보순회전, 우리 동네에서 만나는 보물</strong>
    </a>
    <ul class="info-list special">
    <li><strong>기간</strong>
    <p>2026-05-19~2026-11-29</p></li>
    <li><strong>장소</strong>
    <p>진천종박물관, 영암도기박물관, 의령 의병박물관 등 6개 지역공립박물관</p></li>
    </ul>
<div class="info">
    <div class="mt20 mb10">
    <span class="label-type purple-2">현재전시</span>
    <span class="label-type purple-2">테마전</span>
    </div>
    <a href="?schM=view&menuId=current&exhiSpThemId=3692100&listType=list">
    <strong>아름다움을 나누는 마음-새로 맞이한 기증유물전 2</strong>
    </a>
    <ul class="info-list special">
    <li><strong>기간</strong>
    <p>2026-07-27~2026-11-15</p></li>
    <li><strong>장소</strong>
    <p>기증 4실(상설전시관 2층 205호)</p></li>
    </ul>
"""


def test_reads_title_period_and_place():
    exhibitions = current_exhibitions(LIST_HTML)

    assert [e.title for e in exhibitions] == [
        "우리들의 밥상",
        "아름다움을 나누는 마음-새로 맞이한 기증유물전 2",
    ]
    assert exhibitions[0].start_date == "2026-07-01"
    assert exhibitions[0].end_date == "2026-10-25"
    assert exhibitions[0].place == "국립중앙박물관 특별전시실 2"


def test_drops_exhibitions_held_at_other_museums():
    # 국보순회전은 지역 공립박물관에서 열린다 — 국중박 전시가 아니다. 용산에
    # 없는 전시를 용산 혼잡도 옆에 두면 오독된다.
    titles = [e.title for e in current_exhibitions(LIST_HTML)]
    assert not any("순회전" in title for title in titles)


def test_unescapes_the_title():
    html = LIST_HTML.replace(
        "<strong>우리들의 밥상</strong>",
        "<strong>주제전시 &lt;사계절 푸른 대나무&gt;</strong>",
    )
    assert current_exhibitions(html)[0].title == "주제전시 <사계절 푸른 대나무>"


def test_drops_a_row_without_a_full_period():
    # 기간이 한쪽만 있으면 프론트가 "07.01 – 10.25"를 만들 수 없다. 상시 전시나
    # 개막 전 미정 표기가 이렇게 온다.
    html = LIST_HTML.replace("<p>2026-07-01~2026-10-25</p>", "<p>2026-07-01~</p>")
    assert [e.title for e in current_exhibitions(html)] == [
        "아름다움을 나누는 마음-새로 맞이한 기증유물전 2",
    ]


def test_returns_nothing_when_the_page_shape_changes():
    # 누리집 개편으로 파싱이 통째로 실패하는 경우. 예외가 아니라 빈 목록이어야
    # 프론트가 섹션만 숨기고 혼잡도는 그대로 읽힌다.
    assert current_exhibitions("<html><body>개편 중입니다</body></html>") == []
