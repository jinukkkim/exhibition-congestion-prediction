// 모든 페이지 맨 아래 한 줄. 페이지마다 붙이는 대신 컴포넌트로 둔 이유는
// 링크 주소가 다섯 곳에 흩어지지 않게 하려는 것뿐이다 — 레포를 옮기면 여기만
// 고친다.
//
// 왼쪽에 사이트 이름을 두지 않는다: 홈 헤더가 이미 같은 문구를 쓰고 전시관
// 페이지 헤더는 관 이름을 말하므로, 어느 페이지에서든 바로 위 줄과 겹친다.
// 데이터 출처 표기(공공누리는 네 유형 모두 출처표시를 포함한다)가 들어갈
// 자리도 여기지만, 두 데이터셋의 이용허락범위를 아직 확인하지 않았다.
const REPO_URL = "https://github.com/jinukkkim/exhibition-congestion-prediction";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-hairline/70 pt-6 text-right">
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft transition hover:text-accent"
      >
        GitHub
        {/* 새 탭으로 나간다는 표시. 링크 이름은 "GitHub" 하나로 읽혀야 하므로
            스크린리더에서는 뺀다. */}
        <span aria-hidden="true"> ↗</span>
      </a>
    </footer>
  );
}
