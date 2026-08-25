import { useEffect } from "react";

const SITE = "전시 혼잡도 예측";

// 클라이언트 라우팅이라 문서 제목은 스스로 바뀌지 않는다 — 라우트가 바뀌면 그
// 페이지가 마운트되면서 자기 것으로 덮어쓴다. 그래서 되돌릴 cleanup 이 없다
// (되돌리면 다음 페이지가 쓰기 전에 index.html 의 제목이 한 번 스쳐 지나간다).
// 홈은 사이트 이름 자체가 제목이므로 page 없이 부른다.
export function useDocumentTitle(page?: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${SITE}` : SITE;
  }, [page]);
}
