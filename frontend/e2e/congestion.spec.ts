import { expect, test } from "@playwright/test";

test("renders current congestion and prediction chart from the API", async ({ page }) => {
  // National Museum's congest-level text only renders during business hours
  // (CongestionCard checks real wall-clock time), so pin the clock inside
  // the fixtures' business hours to keep this deterministic around the clock.
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

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

  await page.goto("/venues/national-museum");

  await expect(page.getByText("보통")).toBeVisible();
  await expect(page.getByTestId("prediction-svg")).toBeVisible();
  await expect(page.getByTestId("history-sparkline")).toBeVisible();
});

test("navigates from the home picker to each venue page", async ({ page }) => {
  // Same clock pin as above — the final National Museum revisit step
  // renders the same business-hours-gated congest-level text.
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

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
    route.fulfill({ json: { status: "collecting", days_collected: 0 } })
  );
  await page.route("**/congestion/history*", (route) => route.fulfill({ json: [] }));
  await page.route("**/congestion/daily*", (route) => route.fulfill({ json: [] }));
  await page.route("**/congestion/stream", (route) => route.abort());
  // 덕수궁관은 전시실 하나가 수집 대상이 아니므로 그 관만 응답이 다르다. 모든
  // 관에 활성 방을 주면 실제로는 올 수 없는 상태(서비스 예정인 관이 혼잡도를
  // 보고하는 상태)를 만들게 된다.
  await page.route("**/mmca/rooms*", (route) =>
    route.fulfill({
      json: route.request().url().includes("deoksugung")
        ? [
            {
              space_code: "MMCA-SPACE-4001",
              space_nm: "덕수궁관",
              congestion_nm: null,
              observed_at: null,
            },
          ]
        : [
            {
              space_code: "MMCA-SPACE-1001",
              space_nm: "1전시실",
              congestion_nm: "여유",
              observed_at: "2026-07-24T10:00:00",
            },
          ],
    })
  );
  await page.route("**/mmca/daily*", (route) => route.fulfill({ json: [] }));

  await page.goto("/");
  await expect(page.getByRole("link", { name: "국립중앙박물관" })).toBeVisible();
  await expect(page.getByRole("link", { name: "국립현대미술관 서울관" })).toBeVisible();
  await expect(page.getByRole("link", { name: "국립현대미술관 과천관" })).toBeVisible();
  // 덕수궁관은 갈 곳이 없어 링크가 아니다 — 카드는 이름과 이유만 보여준다.
  await expect(page.getByRole("link", { name: "국립현대미술관 덕수궁관" })).toHaveCount(0);
  await expect(page.getByText("국립현대미술관 덕수궁관")).toBeVisible();

  await page.getByRole("link", { name: "국립현대미술관 서울관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-seoul$/);
  await expect(page.getByText("1전시실")).toBeVisible();

  await page.getByRole("link", { name: "← 미술관 선택" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.getByRole("link", { name: "국립현대미술관 과천관" }).click();
  await expect(page).toHaveURL(/\/venues\/mmca-gwacheon$/);
  await expect(page.getByText("1전시실")).toBeVisible();
  // The shared /mmca/rooms mock returns exactly one room for every venue,
  // so every venue page now renders exactly one chart card.
  await expect(page.getByTestId("mmca-room-chart")).toHaveCount(1);

  await page.getByRole("link", { name: "← 미술관 선택" }).click();
  await expect(page).toHaveURL(/\/$/);

  // 북마크로 남아 있을 수 있는 덕수궁관 주소는 홈으로 돌려보낸다.
  await page.goto("/venues/mmca-deoksugung");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("서비스 예정")).toBeVisible();

  await page.getByRole("link", { name: "국립중앙박물관" }).click();
  await expect(page).toHaveURL(/\/venues\/national-museum$/);
  await expect(page.getByText("보통")).toBeVisible();
});


test("shows every collected field on the raw log page", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

  await page.route("**/congestion/daily/raw*", (route) =>
    route.fulfill({
      json: [
        {
          observed_at: "2026-07-15T09:00:00",
          fields: {
            AREA_CONGEST_LVL: "여유",
            AREA_PPLTN_MIN: 800,
            // 파싱된 컬럼이 아니라 raw_response 에서 흘러온 필드 — 이 페이지의 존재 이유.
            TEMP: "30.2",
          },
        },
      ],
    })
  );

  await page.goto("/logs");

  // exact: 기본 부분일치라 SENSIBLE_TEMP 같은 이웃 컬럼까지 잡는다.
  await expect(page.getByRole("columnheader", { name: "TEMP", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "30.2" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "여유" })).toBeVisible();
});

test("keeps the time column in place while the log scrolls sideways", async ({ page }) => {
  // 43개 필드를 가로로 늘어놓으면 오른쪽 끝 값이 어느 시각의 것인지 알 수 없다.
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

  const fields: Record<string, string> = { AREA_CONGEST_LVL: "여유" };
  for (let i = 0; i < 30; i++) fields[`FIELD_${i}`] = `v${i}`;

  await page.route("**/congestion/daily/raw*", (route) =>
    route.fulfill({ json: [{ observed_at: "2026-07-15T09:00:00", fields }] })
  );

  await page.goto("/logs");

  const timeCell = page.getByRole("cell", { name: "09:00" });
  await timeCell.waitFor();
  const before = await timeCell.boundingBox();

  const scroller = page.getByTestId("log-scroll");
  const lastColumn = page.getByRole("columnheader", { name: "FIELD_29", exact: true });
  const lastBefore = await lastColumn.boundingBox();

  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));

  const lastAfter = await lastColumn.boundingBox();
  // 실제로 가로로 움직였는지 먼저 확인한다 — 안 움직였으면 아래 단언은 공짜로 통과한다.
  expect(lastAfter!.x).toBeLessThan(lastBefore!.x - 100);

  const after = await timeCell.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 0);
  await expect(timeCell).toBeVisible();
});

test("keeps the time column in place in the MMCA log too", async ({ page }) => {
  // 전시실 15개는 데스크톱 폭에서는 다 들어가지만 모바일에서는 넘친다.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

  const rooms = Array.from({ length: 15 }, (_, i) => ({
    space_code: `MMCA-SPACE-10${String(i).padStart(2, "0")}`,
    space_nm: `${i + 1}전시실`,
    congestion_nm: "여유",
  }));

  await page.route("**/mmca/daily*", (route) =>
    route.fulfill({ json: [{ observed_at: "2026-07-15T09:00:00", rooms }] })
  );

  await page.goto("/logs?venue=mmca-seoul");

  const timeCell = page.getByRole("cell", { name: "09:00" });
  await timeCell.waitFor();
  const before = await timeCell.boundingBox();

  const scroller = page.getByTestId("log-scroll");
  const lastColumn = page.getByRole("columnheader", { name: "15전시실", exact: true });
  const lastBefore = await lastColumn.boundingBox();

  await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));

  const lastAfter = await lastColumn.boundingBox();
  expect(lastAfter!.x).toBeLessThan(lastBefore!.x - 100);

  const after = await timeCell.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 0);
  await expect(timeCell).toBeVisible();
});

test("puts the column explanation under the column, not off in a corner", async ({ page }) => {
  // 카드에 backdrop-blur 가 걸려 있어 position: fixed 의 기준이 화면이 아니라
  // 카드가 된다. body 로 portal 하지 않으면 좌표가 통째로 어긋나는데, jsdom 은
  // 그 차이를 못 본다.
  await page.clock.setFixedTime(new Date("2026-07-15T14:30:00"));

  await page.route("**/congestion/daily/raw*", (route) =>
    route.fulfill({
      json: [
        {
          observed_at: "2026-07-15T09:00:00",
          fields: { AREA_CONGEST_LVL: "여유", RESNT_PPLTN_RATE: 45.1 },
        },
      ],
    })
  );

  await page.goto("/logs");

  const header = page.getByRole("columnheader", { name: "RESNT_PPLTN_RATE", exact: true });
  await header.waitFor();
  const headerBox = (await header.boundingBox())!;

  await header.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(/상주인구/);

  const tipBox = (await tooltip.boundingBox())!;
  // 머리글 바로 아래에 붙어 있어야 한다.
  expect(Math.abs(tipBox.y - (headerBox.y + headerBox.height))).toBeLessThan(20);
  // 화면 안에 온전히 들어와야 한다.
  expect(tipBox.x).toBeGreaterThanOrEqual(0);
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});
