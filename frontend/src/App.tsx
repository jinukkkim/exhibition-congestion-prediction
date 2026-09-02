import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage";
import { LogsPage } from "./pages/LogsPage";
import { MmcaPage } from "./pages/MmcaPage";
import { NationalMuseumPage } from "./pages/NationalMuseumPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/venues/national-museum" element={<NationalMuseumPage />} />
        <Route path="/venues/mmca-seoul" element={<MmcaPage venue="seoul" />} />
        <Route path="/venues/mmca-gwacheon" element={<MmcaPage venue="gwacheon" />} />
        <Route path="/venues/mmca-deoksugung" element={<MmcaPage venue="deoksugung" />} />
        {/* 어디에도 없는 주소는 빈 #root 로 끝난다 — 오타나 옛 링크로 들어온
            사람에게 아무것도 없는 화면과 돌아갈 링크 하나 없는 막다른 길을
            주는 셈이다. 홈에 내려놓는다. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
