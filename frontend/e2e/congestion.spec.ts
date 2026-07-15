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

  await page.route("**/congestion/stream", (route) => route.abort());

  await page.goto("/");

  await expect(page.getByText("보통")).toBeVisible();
  await expect(page.getByTestId("prediction-svg")).toBeVisible();
  await expect(page.getByTestId("history-sparkline")).toBeVisible();
});
