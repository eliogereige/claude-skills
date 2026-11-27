import type { ClientModule, ClientPointerEvent } from 'claude-code'

// The Architect's canvas: cards on a cell grid that the person drags, clicks
// to select, and clicks to finish a link. Drawn with the surface's own Box
// and Text; every change goes to the hooks module as a post, which owns the
// design and hands it back as props.

export type CanvasNode = {
  id: string
  label: string
  tag: string
  color: string
  line2: string
  isResource: boolean
  x: number
  y: number
}
export type CanvasEdge = { from: string; to: string; kind: 'then' | 'review' | 'uses' }
export type CanvasProps = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  selected: string | null
  linkFrom: string | null
  rows: number
}

type Held = { id: string; dx: number; dy: number; x: number; y: number; fromX: number; fromY: number; moved: boolean }
// A dropped card's place, shown until the hooks module hands back props that
// differ from where the card stood before the drag (its answer, or a new design).
type Settled = { id: string; x: number; y: number; fromX: number; fromY: number }
// One mutable record per instance: pointer events can arrive several to a
// frame, before a redraw, so the handlers read and write it, never a copy
// captured at render time; setState only asks for the redraw.
type Live = { drag: Held | null; settled: Settled | null }
type State = { live: Live }

export const CARD_W = 24
export const CARD_H = 4

const EDGE_COLOR: Record<CanvasEdge['kind'], string> = { then: 'inactive', review: 'warning', uses: 'suggestion' }

type Pt = { x: number; y: number }

// An orthogonal route of box-drawing cells from one card to another: side to
// side when there is room between them, else top to bottom (or bottom to top).
export const route = (a: Pt, b: Pt): Array<[number, number, string]> => {
  const out: Array<[number, number, string]> = []
  const put = (x: number, y: number, ch: string) => {
    if (x >= 0 && y >= 0) out.push([x, y, ch])
  }
  const midRow = Math.floor(CARD_H / 2)
  const horizontal = (sx: number, sy: number, tx: number, ty: number, arrow: string) => {
    const dir = Math.sign(tx - sx) || 1
    const mid = sx + Math.trunc((tx - sx) / 2)
    for (let x = sx; x !== mid; x += dir) put(x, sy, '─')
    if (sy === ty) {
      for (let x = mid; x !== tx; x += dir) put(x, sy, '─')
    } else {
      const down = ty > sy
      put(mid, sy, dir > 0 ? (down ? '┐' : '┘') : down ? '┌' : '└')
      for (let y = sy + (down ? 1 : -1); y !== ty; y += down ? 1 : -1) put(mid, y, '│')
      put(mid, ty, dir > 0 ? (down ? '└' : '┌') : down ? '┘' : '┐')
      for (let x = mid + dir; x !== tx; x += dir) put(x, ty, '─')
    }
    put(tx, ty, arrow)
  }
  const vertical = (sx: number, sy: number, tx: number, ty: number, arrow: string) => {
    const dir = Math.sign(ty - sy) || 1
    const mid = sy + Math.trunc((ty - sy) / 2)
    for (let y = sy; y !== mid; y += dir) put(sx, y, '│')
    if (sx === tx) {
      for (let y = mid; y !== ty; y += dir) put(sx, y, '│')
    } else {
      const right = tx > sx
      put(sx, mid, dir > 0 ? (right ? '└' : '┘') : right ? '┌' : '┐')
      for (let x = sx + (right ? 1 : -1); x !== tx; x += right ? 1 : -1) put(x, mid, '─')
      put(tx, mid, dir > 0 ? (right ? '┐' : '┌') : right ? '┘' : '└')
      for (let y = mid + dir; y !== ty; y += dir) put(tx, y, '│')
    }
    put(tx, ty, arrow)
  }
  if (b.x - (a.x + CARD_W) >= 3) horizontal(a.x + CARD_W, a.y + midRow, b.x - 1, b.y + midRow, '▶')
  else if (a.x - (b.x + CARD_W) >= 3) horizontal(a.x - 1, a.y + midRow, b.x + CARD_W, b.y + midRow, '◀')
  else if (b.y - (a.y + CARD_H) >= 2) vertical(a.x + CARD_W / 2, a.y + CARD_H, b.x + CARD_W / 2, b.y - 1, '▼')
  else if (a.y - (b.y + CARD_H) >= 2) vertical(a.x + CARD_W / 2, a.y - 1, b.x + CARD_W / 2, b.y + CARD_H, '▲')
  // Cards touching or overlapping: no room for a line; the inspector still lists the link.
  return out
}

const Canvas: ClientModule<CanvasProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const live: Live = surface.state?.live ?? { drag: null, settled: null }
  const redraw = () => surface.setState({ live })
  const cols = Math.max(CARD_W + 2, surface.columns)
  const rows = Math.max(CARD_H + 2, props.rows)
  const clampX = (x: number) => Math.max(0, Math.min(cols - CARD_W, x))
  const clampY = (y: number) => Math.max(0, Math.min(rows - CARD_H, y))

  // Where each card is drawn, always inside the region so it can be grabbed:
  // a card being dragged, or just dropped and not yet handed back, stands
  // where the pointer left it.
  const at = (n: CanvasNode): Pt => {
    const s = live.settled
    if (live.drag?.id === n.id) return { x: live.drag.x, y: live.drag.y }
    if (s?.id === n.id && n.x === s.fromX && n.y === s.fromY) return { x: s.x, y: s.y }
    return { x: clampX(n.x), y: clampY(n.y) }
  }
  if (live.settled && !props.nodes.some(n => n.id === live.settled!.id && n.x === live.settled!.fromX && n.y === live.settled!.fromY)) {
    live.settled = null
  }
  const hit = (x: number, y: number): CanvasNode | undefined =>
    [...props.nodes].reverse().find(n => {
      const p = at(n)
      return x >= p.x && x < p.x + CARD_W && y >= p.y && y < p.y + CARD_H
    })

  surface.onPointer((e: ClientPointerEvent) => {
    if (e.type === 'down' && e.button === 'left') {
      const n = hit(e.x, e.y)
      if (!n) {
        surface.post({ type: 'select', id: null })
        return
      }
      if (props.linkFrom && props.linkFrom !== n.id) {
        surface.post({ type: 'link', to: n.id })
        return
      }
      const p = at(n)
      live.drag = { id: n.id, dx: e.x - p.x, dy: e.y - p.y, x: p.x, y: p.y, fromX: n.x, fromY: n.y, moved: false }
      live.settled = null
      redraw()
      surface.post({ type: 'select', id: n.id })
      return
    }
    const d = live.drag
    if (!d) return
    // A move with no button held means the up went missing: the drag ends
    // there, as it would on the up, so a card never follows a hovering pointer.
    const isEnd = e.type === 'up' || (e.type === 'move' && !e.button)
    const x = clampX(e.x - d.dx)
    const y = clampY(e.y - d.dy)
    if (!isEnd && e.type === 'move') {
      if (x !== d.x || y !== d.y) {
        live.drag = { ...d, x, y, moved: true }
        redraw()
      }
      return
    }
    if (!isEnd) return
    const moved = d.moved || x !== d.x || y !== d.y
    live.drag = null
    live.settled = moved ? { id: d.id, x, y, fromX: d.fromX, fromY: d.fromY } : null
    redraw()
    if (moved) surface.post({ type: 'move', id: d.id, x, y })
  })

  const byId = new Map(props.nodes.map(n => [n.id, n]))
  const runs: Array<{ x: number; y: number; text: string; color: string }> = []
  for (const kind of ['uses', 'then', 'review'] as const) {
    const grid = new Map<number, Map<number, string>>()
    for (const edge of props.edges) {
      const a = byId.get(edge.from)
      const b = byId.get(edge.to)
      if (edge.kind !== kind || !a || !b) continue
      for (const [x, y, ch] of route(at(a), at(b))) {
        if (!grid.has(y)) grid.set(y, new Map())
        grid.get(y)!.set(x, ch)
      }
    }
    for (const [y, line] of grid) {
      const xs = [...line.keys()].sort((p, q) => p - q)
      let start = xs[0]!
      let text = ''
      xs.forEach((x, i) => {
        if (i > 0 && x !== xs[i - 1]! + 1) {
          runs.push({ x: start, y, text, color: EDGE_COLOR[kind] })
          start = x
          text = ''
        }
        text += line.get(x)!
      })
      if (text) runs.push({ x: start, y, text, color: EDGE_COLOR[kind] })
    }
  }

  return (
    <Box flexDirection="column" height={rows} width="100%" position="relative">
      {runs.map(r => (
        <Box position="absolute" top={r.y} left={r.x}>
          <Text color={r.color}>{r.text}</Text>
        </Box>
      ))}
      {props.nodes.map(n => {
        const p = at(n)
        const isSel = props.selected === n.id
        const isSource = props.linkFrom === n.id
        return (
          <Box
            key={`card-${n.id}`}
            position="absolute"
            top={p.y}
            left={p.x}
            width={CARD_W}
            height={CARD_H}
            flexDirection="column"
            paddingX={1}
            borderStyle={n.isResource ? 'single' : 'round'}
            borderColor={isSource ? 'warning' : isSel ? 'claude' : n.color}
            borderDimColor={!isSel && !isSource && n.isResource}
          >
            <Text wrap="truncate-end">
              <Text color={n.color} weight="bold">{n.tag} </Text>
              <Text weight="semibold">{n.label}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">{n.line2}</Text>
          </Box>
        )
      })}
      {props.nodes.length === 0 && (
        <Box position="absolute" top={Math.floor(rows / 2) - 1} left={2}>
          <Text dimColor>Add agents and resources from the palette above, then drag them into place.</Text>
        </Box>
      )}
    </Box>
  )
}

export default Canvas
