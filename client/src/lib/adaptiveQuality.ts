import type { ResolvedQuality } from './streamQuality'

export type InboundVideoSnapshot = {
  packetsLost: number
  packetsReceived: number
  jitterSeconds: number
  framesDropped: number
  framesDecoded: number
  freezeCount: number
}

export type AdaptiveSignal = {
  lossRatio: number
  dropRatio: number
  jitterMs: number
  freezes: number
}

export type AdaptiveQualityState = {
  quality: ResolvedQuality
  maxQuality: ResolvedQuality
  badStreak: number
  goodStreak: number
  lastChangeMs: number
}

const ORDER: readonly ResolvedQuality[] = ['xs', 'sd', 'hq']
const CHANGE_COOLDOWN_MS = 15_000
const UPGRADE_STREAK = 6

function rank(quality: ResolvedQuality): number {
  return ORDER.indexOf(quality)
}

export function initialAdaptiveState(
  quality: ResolvedQuality,
  nowMs = 0,
): AdaptiveQualityState {
  const bounded = quality === 'uhq' ? 'hq' : quality
  return {
    quality: bounded,
    maxQuality: bounded,
    badStreak: 0,
    goodStreak: 0,
    lastChangeMs: nowMs,
  }
}

export function signalFromSnapshots(
  previous: InboundVideoSnapshot,
  current: InboundVideoSnapshot,
): AdaptiveSignal | null {
  const received = Math.max(0, current.packetsReceived - previous.packetsReceived)
  const lost = Math.max(0, current.packetsLost - previous.packetsLost)
  const decoded = Math.max(0, current.framesDecoded - previous.framesDecoded)
  const dropped = Math.max(0, current.framesDropped - previous.framesDropped)
  const packets = received + lost
  const frames = decoded + dropped
  if (packets === 0 && frames === 0) return null
  return {
    lossRatio: packets === 0 ? 0 : lost / packets,
    dropRatio: frames === 0 ? 0 : dropped / frames,
    jitterMs: Math.max(0, current.jitterSeconds * 1000),
    freezes: Math.max(0, current.freezeCount - previous.freezeCount),
  }
}

export function advanceAdaptiveQuality(
  state: AdaptiveQualityState,
  signal: AdaptiveSignal,
  nowMs: number,
): AdaptiveQualityState {
  const bad =
    signal.lossRatio >= 0.05
    || signal.dropRatio >= 0.08
    || signal.jitterMs >= 80
    || signal.freezes > 0
  const severe =
    signal.lossRatio >= 0.15
    || signal.dropRatio >= 0.2
    || signal.freezes > 0
  const good =
    signal.lossRatio < 0.01
    && signal.dropRatio < 0.02
    && signal.jitterMs < 30
    && signal.freezes === 0

  let next = {
    ...state,
    badStreak: bad ? state.badStreak + 1 : 0,
    goodStreak: good ? state.goodStreak + 1 : 0,
  }
  const cooldownReady = nowMs - state.lastChangeMs >= CHANGE_COOLDOWN_MS
  const currentRank = rank(state.quality)
  if (cooldownReady && currentRank > 0 && (severe || next.badStreak >= 2)) {
    next = {
      ...next,
      quality: ORDER[currentRank - 1],
      badStreak: 0,
      goodStreak: 0,
      lastChangeMs: nowMs,
    }
  } else if (
    cooldownReady
    && next.goodStreak >= UPGRADE_STREAK
    && currentRank < rank(state.maxQuality)
  ) {
    next = {
      ...next,
      quality: ORDER[currentRank + 1],
      badStreak: 0,
      goodStreak: 0,
      lastChangeMs: nowMs,
    }
  }
  return next
}

