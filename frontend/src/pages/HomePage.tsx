import { Link } from "react-router-dom";

import { VENUES } from "../venues";

export function HomePage() {
  return (
    <div className="min-h-screen bg-canvas">
      <main className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 lg:px-16">
        <header className="mb-12 border-b border-hairline/70 pb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-ink-soft">
            Exhibition · Seoul
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            전시 혼잡도 예측
          </h1>
        </header>

        <section className="grid gap-6 sm:grid-cols-2">
          {VENUES.map((venue) => (
            <Link
              key={venue.id}
              to={venue.path}
              className="rounded-apple border border-hairline/60 bg-white/70 p-8 shadow-apple backdrop-blur-xl transition hover:border-accent/50"
            >
              <span className="text-xl font-semibold text-ink">{venue.name}</span>
            </Link>
          ))}
        </section>
      </main>
    </div>
  );
}
