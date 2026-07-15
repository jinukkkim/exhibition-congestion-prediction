import { useEffect, useState } from "react";

import { fetchCurrent, type CurrentCongestion } from "./api/congestion";
import { CongestionCard } from "./components/CongestionCard";
import { useCongestionStream } from "./hooks/useCongestionStream";

export default function App() {
  const [initial, setInitial] = useState<CurrentCongestion | null>(null);

  useEffect(() => {
    fetchCurrent().then(setInitial).catch(() => setInitial(null));
  }, []);

  const current = useCongestionStream(initial);

  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="mb-4 text-xl font-semibold">전시 혼잡도 예측</h1>
      <CongestionCard data={current} />
    </main>
  );
}
