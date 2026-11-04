/**
 * Air Touch engine — pure, framework-free hand tracking logic.
 * Every function here is deterministic so it can be unit tested without a camera.
 */

export type Pt = { x: number; y: number; z?: number }
export type Gesture = 'pinch' | 'fist' | 'open' | 'point' | 'peace' | 'thumb' | 'none'

export type AirSettings = {
  sensitivity: number
  dwellMs: number
  dwellRadius: number
  dragMs: number
  doublePinchMs: number
  mirror: boolean
  activeX: [number, number]
  activeY: [number, number]
}

export type Bounds = { x: number; y: number; w: number; h: number }

export const DEFAULT_SETTINGS: AirSettings = {
  sensitivity: 0.55,
  dwellMs: 800,
  dwellRadius: 14,
  dragMs: 550,
  doublePinchMs: 380,
  mirror: true,
  activeX: [0.18, 0.82],
  activeY: [0.14, 0.86],
}

// MediaPipe hand landmark indices.
export const WRIST = 0
export const THUMB_TIP = 4
export const INDEX_MCP = 5
export const INDEX_PIP = 6
export const INDEX_TIP = 8
export const MIDDLE_MCP = 9
export const MIDDLE_PIP = 10
export const MIDDLE_TIP = 12
export const RING_PIP = 14
export const RING_TIP = 16
export const PINKY_MCP = 17
export const PINKY_PIP = 18
export const PINKY_TIP = 20

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Wrist → middle-finger MCP: a stable, scale-free reference for hand size. */
export function handScale(lm: Pt[]): number {
  if (!lm || lm.length < 21) return 0
  return Math.max(1e-4, dist(lm[WRIST], lm[MIDDLE_MCP]))
}

/** Thumb-tip to index-tip distance relative to hand size (≈0.1–0.3 when pinched). */
export function pinchRatio(lm: Pt[]): number {
  const s = handScale(lm)
  if (!s) return Infinity
  return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / s
}

const extended = (lm: Pt[], pip: number, tip: number, scale: number) =>
  dist(lm[tip], lm[WRIST]) > dist(lm[pip], lm[WRIST]) + scale * 0.12

const curled = (lm: Pt[], pip: number, tip: number, scale: number) =>
  dist(lm[tip], lm[WRIST]) < dist(lm[pip], lm[WRIST]) - scale * 0.05

export function classifyGesture(lm: Pt[], pinching = false): Gesture {
  if (!lm || lm.length < 21) return 'none'
  if (pinching || pinchRatio(lm) < 0.28) return 'pinch'
  const s = handScale(lm)
  const index = extended(lm, INDEX_PIP, INDEX_TIP, s)
  const middle = extended(lm, MIDDLE_PIP, MIDDLE_TIP, s)
  const ring = extended(lm, RING_PIP, RING_TIP, s)
  const pinky = extended(lm, PINKY_PIP, PINKY_TIP, s)
  const indexC = curled(lm, INDEX_PIP, INDEX_TIP, s)
  const middleC = curled(lm, MIDDLE_PIP, MIDDLE_TIP, s)
  const ringC = curled(lm, RING_PIP, RING_TIP, s)
  const pinkyC = curled(lm, PINKY_PIP, PINKY_TIP, s)
  if (indexC && middleC && ringC && pinkyC) return 'fist'
  if (index && middle && ring && pinky) return 'open'
  if (index && !middle && !ring && !pinky) return 'point'
  if (index && middle && !ring && !pinky) return 'peace'
  const thumbOut = dist(lm[THUMB_TIP], lm[PINKY_MCP]) > s * 0.95
  if (thumbOut && indexC && middleC && ringC && pinkyC) return 'thumb'
  return 'none'
}

/** Map a normalised camera point into desktop pixels using the active zone. */
export function mapToScreen(p: Pt, bounds: Bounds, s: AirSettings): { x: number; y: number } {
  let nx = p.x
  if (s.mirror) nx = 1 - nx
  const [ax0, ax1] = s.activeX
  const [ay0, ay1] = s.activeY
  const fx = clamp((nx - ax0) / Math.max(1e-6, ax1 - ax0), 0, 1)
  const fy = clamp((p.y - ay0) / Math.max(1e-6, ay1 - ay0), 0, 1)
  return {
    x: Math.round(bounds.x + fx * Math.max(0, bounds.w - 1)),
    y: Math.round(bounds.y + fy * Math.max(0, bounds.h - 1)),
  }
}

/** Exponential smoothing; higher sensitivity follows the hand more closely. */
export function smoothPoint(prev: { x: number; y: number } | null, next: { x: number; y: number }, sensitivity: number) {
  if (!prev) return next
  if (Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5) return prev
  const alpha = clamp(0.08 + sensitivity * 0.85, 0.05, 0.95)
  return { x: prev.x + (next.x - prev.x) * alpha, y: prev.y + (next.y - prev.y) * alpha }
}

/** Dwell-to-click: fires once per hover position and re-arms only after moving away. */
export class DwellTracker {
  private anchor = { x: 0, y: 0 }
  private since = 0
  private started = false
  private armed = true
  private radius: number
  private ms: number

  constructor(settings: AirSettings) {
    this.radius = settings.dwellRadius
    this.ms = settings.dwellMs
  }

  configure(settings: AirSettings) {
    this.radius = settings.dwellRadius
    this.ms = settings.dwellMs
  }

  reset() {
    this.armed = true
    this.started = false
    this.since = 0
    this.anchor = { x: 0, y: 0 }
  }

  update(x: number, y: number, now: number, enabled: boolean): { progress: number; fire: boolean } {
    if (!enabled) {
      this.reset()
      return { progress: 0, fire: false }
    }
    if (!this.started) {
      this.started = true
      this.since = now
      this.anchor = { x, y }
      return { progress: 0, fire: false }
    }
    if (!this.armed) {
      if (Math.hypot(x - this.anchor.x, y - this.anchor.y) > this.radius) {
        this.armed = true
        this.since = now
        this.anchor = { x, y }
      }
      return { progress: 0, fire: false }
    }
    if (Math.hypot(x - this.anchor.x, y - this.anchor.y) > this.radius) {
      this.anchor = { x, y }
      this.since = now
      return { progress: 0, fire: false }
    }
    const progress = this.ms > 0 ? clamp((now - this.since) / this.ms, 0, 1) : 1
    if (progress >= 1) {
      this.armed = false
      return { progress: 1, fire: true }
    }
    return { progress, fire: false }
  }
}

export type PinchEvent = 'drag-start' | 'drag-end' | 'click' | 'double-click' | null

/** Pinch to click, hold to drag, quick double pinch to double-click. */
export class PinchTracker {
  private pinched = false
  private startedAt = 0
  private dragging = false
  private pendingAt = 0
  private lastReleaseAt = 0
  private dragMs: number
  private doubleMs: number

  constructor(settings: AirSettings) {
    this.dragMs = settings.dragMs
    this.doubleMs = settings.doublePinchMs
  }

  configure(settings: AirSettings) {
    this.dragMs = settings.dragMs
    this.doubleMs = settings.doublePinchMs
  }

  reset() {
    this.pinched = false
    this.dragging = false
    this.startedAt = 0
    this.pendingAt = 0
    this.lastReleaseAt = 0
  }

  get isPinching() {
    return this.pinched
  }

  get isDragging() {
    return this.dragging
  }

  update(ratio: number, now: number, enabled: boolean): { event: PinchEvent; pinching: boolean; dragging: boolean } {
    if (!enabled) {
      const wasDragging = this.dragging
      this.reset()
      return { event: wasDragging ? 'drag-end' : null, pinching: false, dragging: false }
    }
    // A single click waits one double-click window so a second pinch can turn
    // it into a double-click instead of producing a stray click first.
    if (this.pendingAt && now - this.pendingAt >= this.doubleMs) {
      this.pendingAt = 0
      return { event: 'click', pinching: this.pinched, dragging: false }
    }
    if (!this.pinched && ratio < 0.28) {
      this.pinched = true
      this.startedAt = now || 1
      return { event: null, pinching: true, dragging: false }
    }
    if (this.pinched && ratio > 0.42) {
      this.pinched = false
      if (this.dragging) {
        this.dragging = false
        return { event: 'drag-end', pinching: false, dragging: false }
      }
      if (this.lastReleaseAt && now - this.lastReleaseAt <= this.doubleMs) {
        this.lastReleaseAt = 0
        this.pendingAt = 0
        return { event: 'double-click', pinching: false, dragging: false }
      }
      this.lastReleaseAt = now
      this.pendingAt = now
      return { event: null, pinching: false, dragging: false }
    }
    if (this.pinched && !this.dragging && now - this.startedAt >= this.dragMs) {
      this.dragging = true
      return { event: 'drag-start', pinching: true, dragging: true }
    }
    return { event: null, pinching: this.pinched, dragging: this.dragging }
  }
}

/** Fist must be held this long before it is treated as the emergency stop. */
export const FIST_STOP_MS = 500
/** Open palm must be held this long before it pauses/resumes tracking. */
export const PALM_PAUSE_MS = 650

/** Tracks how long one gesture has been held continuously. */
export class GestureHold {
  private gesture: Gesture = 'none'
  private since = 0

  update(g: Gesture, now: number): { gesture: Gesture; heldMs: number; since: number } {
    if (g !== this.gesture) {
      this.gesture = g
      this.since = now
    }
    return { gesture: this.gesture, heldMs: this.since ? now - this.since : 0, since: this.since }
  }

  reset() {
    this.gesture = 'none'
    this.since = 0
  }
}
