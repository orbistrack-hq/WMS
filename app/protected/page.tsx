import { redirect } from "next/navigation"

// The dashboard now lives under the (app) shell at /dashboard.
// Keep this route as a redirect for any existing links or bookmarks.
export default function ProtectedPage() {
  redirect("/dashboard")
}
