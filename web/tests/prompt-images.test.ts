import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

for (const path of ["components/prompts/prompt-card.tsx", "pages/prompts/components/prompt-detail-dialog.tsx", "pages/home/index.tsx", "components/canvas/canvas-side-panel.tsx", "components/layout/prompt-source-content-modal.tsx", "pages/assets/index.tsx"]) {
    test(`prompt images at ${path} require reactive, separate feed consent`, () => {
        const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
        expect(source).toContain('useBackgroundPermission("promptFeed")');
        expect(source).toContain("allowImages &&");
    });
}
