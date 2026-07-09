export const REBOOT_GUARD_SECONDS = 1800

const LADDER = [
  'restart_mediamtx',
  'restart_mediamtx',
  'restart_nvargus',
  'restart_nvargus',
  'reboot',
] as const

export type WatchdogTone = 'ok' | 'warn' | 'down'

export function actionLabel(action: string | null | undefined): string {
  switch (action) {
    case 'restart_mediamtx':
      return 'MediaMTX restart'
    case 'restart_nvargus':
      return 'nvargus-daemon restart'
    case 'reboot':
      return 'Reboot'
    default:
      return 'No action'
  }
}

export function rungName(level: number | null | undefined): string {
  if (level == null || level <= 0) return 'Healthy - bottom rung'
  const idx = Math.min(Math.floor(level), LADDER.length - 1)
  return actionLabel(LADDER[idx])
}

export function rungTone(level: number | null | undefined): WatchdogTone {
  if (level == null || level <= 0) return 'ok'
  if (level <= 2) return 'warn'
  return 'down'
}

export function rungDisplay(level: number | null | undefined): string {
  if (level == null || level <= 0) return 'Healthy - bottom rung'
  const safe = Math.min(Math.floor(level), LADDER.length - 1)
  return `Rung ${safe} of ${LADDER.length} - ${rungName(safe)}`
}
