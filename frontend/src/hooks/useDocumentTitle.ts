import { useEffect } from "react";

// index.html 의 WebSite 구조화 데이터(구글 사이트 이름)도 같은 이름을 쓴다.
export const SITE = "전시 혼잡도 예측";
// 홈 제목은 사이트 이름과 다르게 둔다 — 구글 검색 결과는 사이트 이름을 제목 위에
// 따로 보여줘서, 같으면 "전시 혼잡도 예측" 이 두 줄 연달아 찍힌다. 검색어가 될
// 관 이름을 앞에 둔다. index.html 의 <title> 과 같아야 한다.
export const HOME_TITLE = "국립중앙박물관·국립현대미술관 혼잡도";

// 클라이언트 라우팅이라 문서 제목은 스스로 바뀌지 않는다 — 라우트가 바뀌면 그
// 페이지가 마운트되면서 자기 것으로 덮어쓴다. 그래서 되돌릴 cleanup 이 없다
// (되돌리면 다음 페이지가 쓰기 전에 index.html 의 제목이 한 번 스쳐 지나간다).
// 홈은 page 없이 부르고 HOME_TITLE 을 쓴다.
export function useDocumentTitle(page?: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${SITE}` : HOME_TITLE;
  }, [page]);
}
