// ---------------------------------------------------------------------------
// Catalog domain helpers — multi-level categories (adjacency list).
// ---------------------------------------------------------------------------

export type CategoryRow = {
  id: string
  name: string
  parent_id: string | null
}

export type CategoryNode = CategoryRow & {
  depth: number
  /** Full path from root, e.g. "Food > Honey". */
  path: string
  children: CategoryNode[]
}

/** Build a sorted forest of category nodes with depth + full path. */
export function buildCategoryTree(rows: CategoryRow[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>()
  for (const r of rows) {
    byId.set(r.id, { ...r, depth: 0, path: r.name, children: [] })
  }

  const roots: CategoryNode[] = []
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const byName = (a: CategoryNode, b: CategoryNode) =>
    a.name.localeCompare(b.name)

  const visit = (node: CategoryNode, depth: number, prefix: string) => {
    node.depth = depth
    node.path = prefix ? `${prefix} > ${node.name}` : node.name
    node.children.sort(byName)
    for (const child of node.children) visit(child, depth + 1, node.path)
  }
  roots.sort(byName)
  for (const root of roots) visit(root, 0, "")

  return roots
}

/** Depth-first flat list (for indented <select> options and tables). */
export function flattenCategoryTree(roots: CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = []
  const walk = (node: CategoryNode) => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const root of roots) walk(root)
  return out
}

/** Map of categoryId -> full path, for quick lookups in lists. */
export function categoryPathMap(rows: CategoryRow[]): Map<string, string> {
  const flat = flattenCategoryTree(buildCategoryTree(rows))
  return new Map(flat.map((n) => [n.id, n.path]))
}

/**
 * Ids of a category and all its descendants. Used to prevent cycles when
 * reparenting: a category may not become a child of itself or its descendants.
 */
export function descendantIds(
  rows: CategoryRow[],
  rootId: string,
): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const r of rows) {
    if (r.parent_id) {
      const list = childrenByParent.get(r.parent_id) ?? []
      list.push(r.id)
      childrenByParent.set(r.parent_id, list)
    }
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()!
    for (const child of childrenByParent.get(id) ?? []) {
      if (!out.has(child)) {
        out.add(child)
        stack.push(child)
      }
    }
  }
  return out
}

/** Indentation string for a select option at a given depth. */
export function indent(depth: number): string {
  return depth > 0 ? `${"  ".repeat(depth)}↳ ` : ""
}
