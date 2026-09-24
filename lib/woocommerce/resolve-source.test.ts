import { describe, expect, it } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

import { resolveWooSource } from "./resolve-source"

function fakeClient(result: { data: unknown; error: unknown }) {
  const q = {
    select: () => q,
    eq: () => q,
    then: (res: (v: unknown) => unknown) => Promise.resolve(result).then(res),
  }
  return { from: () => q } as unknown as SupabaseClient
}

const rows = [
  { source: "https://budclubshop.com", source_aliases: ["https://budclub.com"] },
  { source: "https://other.com", source_aliases: null },
]

describe("resolveWooSource", () => {
  it("maps an alias to the canonical source", async () => {
    const c = fakeClient({ data: rows, error: null })
    expect(await resolveWooSource(c, "https://budclub.com")).toBe(
      "https://budclubshop.com",
    )
  })

  it("keeps an exact canonical match", async () => {
    const c = fakeClient({ data: rows, error: null })
    expect(await resolveWooSource(c, "https://budclubshop.com")).toBe(
      "https://budclubshop.com",
    )
  })

  it("passes unknown sources and lookup errors through unchanged", async () => {
    expect(
      await resolveWooSource(fakeClient({ data: rows, error: null }), "https://x.com"),
    ).toBe("https://x.com")
    expect(
      await resolveWooSource(
        fakeClient({ data: null, error: { message: "column does not exist" } }),
        "https://budclub.com",
      ),
    ).toBe("https://budclub.com")
  })
})
