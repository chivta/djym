import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.DJYM_TEST_URL || "http://localhost:8092",
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: process.env.DJYM_TEST_URL
    ? undefined
    : {
        command: "go run ./tests/shellserver",
        url: "http://localhost:8092",
        reuseExistingServer: false,
      },
});
