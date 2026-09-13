import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { LogsPage } from "./pages/LogsPage";
import { MmcaPage } from "./pages/MmcaPage";
import { MmcaQuietHoursPage } from "./pages/MmcaQuietHoursPage";
import { NationalMuseumPage } from "./pages/NationalMuseumPage";
import { QuietHoursPage } from "./pages/QuietHoursPage";
import { VisitorsPage } from "./pages/VisitorsPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        {/* 아래 둘은 개발자용이다. UI 어디에서도 링크하지 않고 robots.txt 가
            크롤링을 막지만, 주소를 아는 사람은 그대로 열 수 있다 — 수집
            원본과 집계 숫자뿐이라 그 이상은 잠그지 않았다. 라우트를 지우지
            않는 이유도 그것이다: 숨기려는 것이지 없애려는 것이 아니다. */}
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/visitors" element={<VisitorsPage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
        {/* 관 페이지 아래에 둔다 — 같은 관을 다루는 페이지이고, 검색으로
            들어온 사람이 주소만 보고도 어디 소속인지 알게 된다. */}
        <Route path="/venues/national-museum/when" element={<QuietHoursPage />} />
        <Route path="/venues/mmca-seoul" element={<MmcaPage venue="seoul" />} />
        {/* 덕수궁관에는 같은 라우트를 두지 않는다 — 판독에 혼잡도가 실리지 않아
            격자가 통째로 빈다. 빈 페이지는 검색에도 관람객에게도 줄 것이 없다. */}
        <Route path="/venues/mmca-seoul/when" element={<MmcaQuietHoursPage venue="seoul" />} />
        <Route path="/venues/mmca-gwacheon" element={<MmcaPage venue="gwacheon" />} />
        <Route
          path="/venues/mmca-gwacheon/when"
          element={<MmcaQuietHoursPage venue="gwacheon" />}
        />
        <Route path="/venues/mmca-deoksugung" element={<MmcaPage venue="deoksugung" />} />
        {/* 어디에도 없는 주소는 빈 #root 로 끝난다 — 오타나 옛 링크로 들어온
            사람에게 아무것도 없는 화면과 돌아갈 링크 하나 없는 막다른 길을
            주는 셈이다. 홈에 내려놓는다. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
