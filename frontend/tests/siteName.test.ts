/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

import html from "../index.html?raw";
import { HOME_TITLE, SITE } from "../src/hooks/useDocumentTitle";

describe("index.html site name", () => {
  it("declares a WebSite whose name matches the title suffix", () => {
    const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(block).not.toBeNull();
    const data = JSON.parse(block![1]);
    expect(data["@type"]).toBe("WebSite");
    expect(data.name).toBe(SITE);
    expect(data.url).toBe("https://exhibition-traffic.duckdns.org/");
  });

  it("keeps the home title apart from the site name and in sync with the hook", () => {
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    expect(HOME_TITLE).not.toBe(SITE);
  });

  it("names the site for link previews too", () => {
    expect(html).toContain(`<meta property="og:site_name" content="${SITE}" />`);
  });
});
