import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["html", "default"],
    outputFile: "./out/test-html/index.html",
  },
});
