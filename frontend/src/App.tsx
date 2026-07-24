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
        <Route path="/venues/mmca" element={<MmcaPage />} />
      </Routes>
    </BrowserRouter>
  );
}
