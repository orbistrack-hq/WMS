import fs from "node:fs"

import { test, expect } from "@playwright/test"

// Order provisioned in auth.setup.ts. Read inside beforeAll (not at import time)
// so it's available after the setup project has run.
type ReadyOrder = { orderId: string; orderNumber: string; groupId: string }
let order: ReadyOrder

test.beforeAll(() => {
  order = JSON.parse(fs.readFileSync("e2e/.data/order.json", "utf8"))
})

test("pick → pack → fulfill a group end to end", async ({ page }) => {
  // 1) The group opens in a "needs packing" state.
  await page.goto(`/packing/${order.groupId}`)
  await expect(page.getByText("Needs packing")).toBeVisible()

  // 2) Pick every line via each row's "All" button.
  // Exact name: this page also has "Pick list" and "Go to picking" links.
  await page.getByRole("link", { name: "Pick", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/packing/${order.groupId}/pick$`))

  const allButtons = page.getByRole("button", { name: /^All$/ })
  const rowCount = await allButtons.count()
  expect(rowCount).toBeGreaterThan(0)
  // The "picking complete" banner reflects optimistic state, so wait for each
  // set_pick_qty server action to actually commit before navigating away —
  // otherwise leaving the page cancels the in-flight write and the pick is lost.
  for (let i = 0; i < rowCount; i++) {
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().includes(`/packing/${order.groupId}/pick`),
      ),
      allButtons.nth(i).click(),
    ])
  }
  await expect(page.getByText(/picking complete/i)).toBeVisible()

  // 3) Return to the group and confirm packed.
  await page.getByRole("link", { name: /pack group/i }).click()
  await expect(page).toHaveURL(new RegExp(`/packing/${order.groupId}$`))

  const confirm = page.getByRole("button", { name: /confirm packed/i })
  await expect(confirm).toBeEnabled()
  await confirm.click()
  // After packing, the confirm card switches from "Confirm packed" to "Save note".
  await expect(page.getByRole("button", { name: /save note/i })).toBeVisible()

  // 4) Fulfill (ship) from the order page and confirm the terminal state.
  await page.goto(`/orders/${order.orderId}`)
  await page.getByRole("button", { name: /^Fulfill$/ }).click()
  await expect(page.getByText(/can no longer change/i)).toBeVisible()
})
