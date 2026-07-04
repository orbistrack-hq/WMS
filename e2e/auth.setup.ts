import fs from "node:fs"
import path from "node:path"

import { test as setup, expect } from "@playwright/test"

import {
  createReadyOrder,
  ensureTestUser,
  TEST_EMAIL,
  TEST_PASSWORD,
} from "./fixtures/provision"

const authFile = "e2e/.auth/user.json"
const dataFile = "e2e/.data/order.json"

// Runs once before the specs (they depend on the "setup" project). Provisions a
// ready-to-pack order, then logs in through the real UI and saves the session.
setup("provision data and authenticate", async ({ page }) => {
  await ensureTestUser()

  const order = await createReadyOrder()
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(order, null, 2))

  await page.goto("/auth/login")
  await page.getByLabel("Email").fill(TEST_EMAIL)
  await page.getByLabel("Password").fill(TEST_PASSWORD)
  await page.getByRole("button", { name: "Login" }).click()
  await page.waitForURL("**/dashboard")
  await expect(page).toHaveURL(/\/dashboard/)

  fs.mkdirSync(path.dirname(authFile), { recursive: true })
  await page.context().storageState({ path: authFile })
})
