import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { MmcaPage } from "./pages/MmcaPage";
import { NationalMuseumPage } from "./pages/NationalMuseumPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
        <Route
          path="/venues/mmca-seoul"
          element={<MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-gwacheon"
          element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />}
        />
        {/* 덕수궁관은 전시실이 하나뿐이고 그것이 수집 대상이 아니라, 이 페이지는
            채워질 일이 없는 빈 껍데기다. 홈 카드에서 링크를 없앴으므로 남은
            진입 경로(북마크·방문기록)도 홈으로 돌려보낸다 — 홈 카드가 "서비스
            예정"으로 이유를 말한다. 수집이 재개되면 이 라우트를 되살릴 것. */}
        <Route path="/venues/mmca-deoksugung" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
