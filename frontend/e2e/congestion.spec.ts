import { expect, test } from "@playwright/test";

test("renders current congestion and prediction chart from the API", async ({ page }) => {
  await page.route("**/congestion/current", (route) =>
    route.fulfill({
      json: {
        observed_at: "2026-07-15T14:30:00",
        congest_level: "보통",
        population_avg: 1500,
      },
    })
  );

  await page.route("**/congestion/prediction", (route) =>
    route.fulfill({
      json: {
        status: "ready",
        baseline_mae: 120.5,
        model_mae: 95.2,
        curve: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          baseline: 1000 + hour,
          model: 1050 + hour,
        })),
      },
    })
  );

  await page.route("**/congestion/history*", (route) =>
    route.fulfill({
      json: [
        { observed_at: "2026-07-15T08:30:00", population_avg: 800 },
        { observed_at: "2026-07-15T14:30:00", population_avg: 1500 },
      ],
    })
  );

  await page.route("**/congestion/daily*", (route) =>
    route.fulfill({
      json: [
        {
          observed_at: "2026-07-16T09:00:00",
          congest_level: "여유",
          population_min: 800,
          population_max: 1000,
          male_ppltn_rate: 51.8,
          female_ppltn_rate: 48.2,
          ppltn_rate_0: null,
          ppltn_rate_10: null,
          ppltn_rate_20: null,
          ppltn_rate_30: null,
          ppltn_rate_40: null,
          ppltn_rate_50: null,
          ppltn_rate_60: null,
          ppltn_rate_70: null,
          resnt_ppltn_rate: 45.1,
          non_resnt_ppltn_rate: 54.9,
        },
      ],
    })
  );

  await page.route("**/congestion/stream", (route) => route.abort());

  await page.goto("/");

  await expect(page.getByText("보통")).toBeVisible();
  await expect(page.getByTestId("prediction-svg")).toBeVisible();
  await expect(page.getByTestId("history-sparkline")).toBeVisible();
  await expect(page.getByText("09:00")).toBeVisible();
});
