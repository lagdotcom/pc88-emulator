import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["json", "default"],
    outputFile: "./out/test-output.json",
  },
});
