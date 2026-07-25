import { BrowserRouter, Route, Routes } from "react-router-dom";

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
          path="/venues/mmca"
          element={<MmcaPage venue="seoul" title="국립현대미술관 서울관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-gwacheon"
          element={<MmcaPage venue="gwacheon" title="국립현대미술관 과천관 혼잡도" />}
        />
        <Route
          path="/venues/mmca-deoksugung"
          element={<MmcaPage venue="deoksugung" title="국립현대미술관 덕수궁관 혼잡도" />}
        />
      </Routes>
    </BrowserRouter>
  );
}
