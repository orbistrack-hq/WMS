import { defineConfig, devices } from "@playwright/test"
import { config as loadEnv } from "dotenv"

// Load E2E-specific vars first, then the app's .env.local for anything shared
// (Supabase URL/keys). dotenv won't override already-set vars, so .env.e2e wins.
loadEnv({ path: ".env.e2e" })
loadEnv({ path: ".env.local" })

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000"

export default defineConfig({
  testDir: "./e2e",
  // The pack/ship flow is a single stateful sequence, so keep it serial.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "html",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // Provisions the test user + a ready-to-pack order, then logs in and saves
    // the authenticated storage state for the specs to reuse.
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],
  // Starts the app if one isn't already running. Point NEXT_PUBLIC_SUPABASE_*
  // at your LOCAL Supabase (supabase start) so the run is seedable/disposable.
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
