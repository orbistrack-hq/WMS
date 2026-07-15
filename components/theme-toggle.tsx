"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // Client-only init: localStorage / the DOM class aren't available during
    // SSR render, so the theme is read after mount. Intentional setState-on-
    // mount, not a synchronization loop.
    const stored = localStorage.getItem("theme")
    const isDark = stored
      ? stored === "dark"
      : document.documentElement.classList.contains("dark")
    /* eslint-disable react-hooks/set-state-in-effect */
    setTheme(isDark ? "dark" : "light")
    setMounted(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  function toggle() {
    const next = theme === "dark" ? "light" : "dark"
    setTheme(next)
    localStorage.setItem("theme", next)
    const classes = document.documentElement.classList
    classes.remove("light", "dark")
    classes.add(next)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-md p-2 text-muted-foreground hover:bg-muted"
      aria-label={
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
      }
    >
      {mounted && theme === "dark" ? (
        <Sun className="size-5" />
      ) : (
        <Moon className="size-5" />
      )}
    </button>
  )
}
