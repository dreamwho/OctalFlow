import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteLogo } from "./site-logo";

describe("SiteLogo", () => {
    it("renders the configured backend logo in both theme slots without leaking the current page referrer", () => {
        const markup = renderToStaticMarkup(<SiteLogo logoUrl="https://cdn.example.com/brand.svg" className="size-8" />);

        expect(markup.match(/src="https:\/\/cdn\.example\.com\/brand\.svg"/g)).toHaveLength(2);
        expect(markup).toContain('referrerPolicy="no-referrer"');
        expect(markup).not.toContain("url(/logo.svg)");
    });

    it("keeps the bundled dreamyo mark as a safe loading fallback", () => {
        const markup = renderToStaticMarkup(<SiteLogo logoUrl="/logo.svg" className="size-8" />);

        expect(markup.match(/src="\/brand\/dreamyo\/mark\.png"/g)).toHaveLength(2);
        expect(markup).toContain("size-8");
    });
});
