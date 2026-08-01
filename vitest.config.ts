import { defineConfig } from "vitest/config";

// Utan denna config sveper vitest .worktrees/*/test/**  också (samma testfiler
// som huvudarbetsträdet) - dubblerar varje testkörning och räknar samma
// pre-existing miss två gånger. .worktrees/ är arbetsytor för isolerad
// implementation (se docs/superpowers), inte del av huvudträdets testyta.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**"],
  },
});
