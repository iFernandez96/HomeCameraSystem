import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createCameraExposurePreset,
  deleteCameraExposurePreset,
  getCameraExposure,
  getRecoverStatus,
  listCameraExposurePresets,
  putCameraExposure,
  type CameraExposure,
  type CameraExposurePreset,
} from '../lib/api'
import { errFields, log } from '../lib/log'
import { DEFAULT_CAMERA_PATH, whepUrlForPath } from '../lib/streamQuality'
import { connectWhep, type WhepConnection } from '../lib/webrtc'

type Drag = { kind: 'move' | 'resize'; startX: number; startY: number; original: CameraExposure }
const DEFAULTS: CameraExposure = {
  enabled: false, x: 0.25, y: 0.25, width: 0.5, height: 0.5, compensation: 0, locked: false,
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

export function ExposureAssistant() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const refreshPendingRef = useRef(false)
  const refreshSuccessRef = useRef('Exposure applied. Preview updated.')
  const currentAppliedRef = useRef<CameraExposure>(DEFAULTS)
  const [config, setConfig] = useState(DEFAULTS)
  const [undoConfig, setUndoConfig] = useState<CameraExposure | null>(null)
  const [presets, setPresets] = useState<CameraExposurePreset[]>([])
  const [presetName, setPresetName] = useState('')
  const [presetSaving, setPresetSaving] = useState(false)
  const [stream, setStream] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [previewNonce, setPreviewNonce] = useState(0)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    getCameraExposure().then((value) => {
      if (!cancelled) {
        currentAppliedRef.current = value
        setConfig(value)
      }
    }).catch((error) => {
      log.warn('exposureAssistant:load-failed', errFields(error))
      if (!cancelled) setMessage('Could not load the saved exposure settings.')
    })
    listCameraExposurePresets().then((value) => {
      if (!cancelled) setPresets(value.presets)
    }).catch((error) => {
      log.warn('exposureAssistant:presets-load-failed', errFields(error))
      if (!cancelled) setMessage('Exposure controls loaded, but saved zones are unavailable.')
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const controller = new AbortController()
    let connection: WhepConnection | null = null
    let cancelled = false
    connectWhep(whepUrlForPath(`${DEFAULT_CAMERA_PATH}_uhq`), video, { signal: controller.signal })
      .then((next) => { if (cancelled) next.close(); else connection = next })
      .catch((error) => { if (!cancelled) { log.error('exposureAssistant:whep-failed', errFields(error)); setStream('error') } })
    const live = () => {
      setStream('live')
      if (refreshPendingRef.current) {
        refreshPendingRef.current = false
        setMessage(refreshSuccessRef.current)
      }
    }
    video.addEventListener('playing', live)
    video.addEventListener('loadeddata', live)
    return () => {
      cancelled = true
      controller.abort()
      connection?.close()
      video.removeEventListener('playing', live)
      video.removeEventListener('loadeddata', live)
    }
  }, [previewNonce])

  const refreshPreview = () => {
    setStream('connecting')
    setPreviewNonce((value) => value + 1)
  }

  const coordinates = (event: ReactPointerEvent) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  const startDrag = (kind: Drag['kind'], event: ReactPointerEvent) => {
    const point = coordinates(event)
    if (!point) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { kind, startX: point.x, startY: point.y, original: config }
  }
  const moveDrag = (event: ReactPointerEvent) => {
    const drag = dragRef.current
    const point = coordinates(event)
    if (!drag || !point) return
    const dx = point.x - drag.startX
    const dy = point.y - drag.startY
    setConfig((value) => drag.kind === 'move'
      ? { ...value, enabled: true, x: clamp(drag.original.x + dx, 0, 1 - value.width), y: clamp(drag.original.y + dy, 0, 1 - value.height) }
      : { ...value, enabled: true, width: clamp(drag.original.width + dx, 0.25, 1 - value.x), height: clamp(drag.original.height + dy, 0.25, 1 - value.y) })
  }

  const applyExposure = async (nextConfig: CameraExposure, action: 'save' | 'restore' | 'undo') => {
    setSaving(true); setMessage('Applying exposure… the feed may pause briefly.')
    try {
      const previous = currentAppliedRef.current
      const result = await putCameraExposure(nextConfig)
      for (let attempt = 0; attempt < 75; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        const status = await getRecoverStatus(result.request_id)
        if (status.status === 'done') {
          currentAppliedRef.current = nextConfig
          setConfig(nextConfig)
          setUndoConfig(previous)
          refreshPendingRef.current = true
          refreshSuccessRef.current = action === 'undo'
            ? 'Previous exposure restored. Preview updated.'
            : action === 'restore'
              ? 'Saved zone restored. Preview updated.'
              : 'Exposure applied. Preview updated.'
          setMessage(`${action === 'undo' ? 'Previous exposure restored' : action === 'restore' ? 'Saved zone restored' : 'Exposure applied'}. Refreshing preview…`)
          refreshPreview()
          return
        }
        if (status.status === 'failed' || status.status === 'expired') throw new Error(status.detail ?? 'Camera rejected the change')
      }
      throw new Error('Camera is still applying the change')
    } catch (error) {
      log.error('exposureAssistant:save-failed', errFields(error))
      setMessage('Exposure was not applied. The previous camera settings were restored.')
    } finally { setSaving(false) }
  }

  const captureThumbnail = () => {
    const video = videoRef.current
    if (!video || video.readyState < 2) throw new Error('Camera frame is not ready')
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Thumbnail canvas is unavailable')
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.72)
  }

  const savePreset = async () => {
    const name = presetName.trim()
    if (!name) { setMessage('Enter a name for this exposure zone.'); return }
    setPresetSaving(true)
    try {
      const preset = await createCameraExposurePreset(name, captureThumbnail(), config)
      setPresets((value) => [preset, ...value].slice(0, 24))
      setPresetName('')
      setMessage(`Saved “${preset.name}” with the current camera image.`)
    } catch (error) {
      log.error('exposureAssistant:preset-save-failed', errFields(error))
      setMessage('Could not save this exposure zone and thumbnail.')
    } finally { setPresetSaving(false) }
  }

  const removePreset = async (preset: CameraExposurePreset) => {
    try {
      await deleteCameraExposurePreset(preset.id)
      setPresets((value) => value.filter((item) => item.id !== preset.id))
      setMessage(`Deleted “${preset.name}”.`)
    } catch (error) {
      log.error('exposureAssistant:preset-delete-failed', { presetId: preset.id, ...errFields(error) })
      setMessage('Could not delete that saved exposure zone.')
    }
  }

  return (
    <section aria-labelledby="exposure-heading" className="mx-auto max-w-5xl px-4 py-4 md:px-6 md:py-6">
      <header className="mb-4 flex items-center gap-3">
        <button type="button" aria-label="Back to Settings" onClick={() => navigate('/settings')} className="grid min-h-11 min-w-11 place-items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] text-2xl">‹</button>
        <div><h1 id="exposure-heading" className="text-2xl font-semibold text-[var(--color-text-primary)]">Adjust exposure</h1><p className="text-sm text-[var(--color-text-secondary)]">Place the box over what should be clearly visible.</p></div>
      </header>
      <div className="mb-4 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p className="font-semibold text-[var(--color-text-primary)]">1440p30 exposure preview</p>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">The high-detail stream is shared with Live and Focus Assistant; detection stays on its separate 720p stream.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_320px]">
        <div ref={frameRef} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null }} className="relative aspect-video touch-none overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-black">
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
          {config.enabled && <div role="region" aria-label="Exposure metering area" onPointerDown={(event) => startDrag('move', event)} className="absolute cursor-move border-2 border-[var(--color-accent-default)] bg-transparent shadow-[0_0_0_9999px_rgba(0,0,0,.22)]" style={{ left: `${config.x * 100}%`, top: `${config.y * 100}%`, width: `${config.width * 100}%`, height: `${config.height * 100}%` }}><button type="button" aria-label="Resize exposure area" onPointerDown={(event) => { event.stopPropagation(); startDrag('resize', event) }} className="absolute -bottom-3 -right-3 h-7 w-7 rounded-full border-2 border-white bg-[var(--color-accent-default)]" /></div>}
          {stream !== 'live' && (
            <div className="absolute inset-0 grid place-items-center bg-black/65 text-center text-white">
              {stream === 'connecting' ? (
                <p>Connecting to the camera…</p>
              ) : (
                <div>
                  <p className="mb-3">Camera preview unavailable.</p>
                  <button type="button" onClick={refreshPreview} className="min-h-11 rounded-full bg-white px-5 font-semibold text-black">Retry</button>
                </div>
              )}
            </div>
          )}
        </div>
        <aside className="card-paper space-y-5 p-4">
          <div><p className="font-semibold text-[var(--color-text-primary)]">Metering area</p><p className="mt-1 text-sm text-[var(--color-text-secondary)]">This guides brightness for the whole image. It does not brighten only the box.</p></div>
          <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfig((value) => ({ ...value, enabled: true }))} className={`min-h-11 rounded-full border px-3 font-semibold ${config.enabled ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)]' : 'border-[var(--color-border)]'}`}>Selected area</button><button type="button" onClick={() => setConfig((value) => ({ ...value, enabled: false, locked: false }))} className={`min-h-11 rounded-full border px-3 font-semibold ${!config.enabled ? 'bg-[var(--color-ink)] text-[var(--color-on-ink)]' : 'border-[var(--color-border)]'}`}>Whole image</button></div>
          <label className="block"><span className="flex justify-between text-sm font-semibold"><span>Exposure adjustment</span><span>{config.compensation > 0 ? '+' : ''}{config.compensation.toFixed(1)}</span></span><input aria-label="Exposure adjustment" type="range" min="-2" max="2" step="0.1" value={config.compensation} onChange={(event) => setConfig((value) => ({ ...value, compensation: Number(event.target.value) }))} className="mt-3 w-full" /><span className="flex justify-between text-xs text-[var(--color-text-tertiary)]"><span>Darker</span><span>Brighter</span></span></label>
          <button type="button" onClick={() => setConfig(DEFAULTS)} className="min-h-11 w-full rounded-full border border-[var(--color-border)] font-semibold">Reset</button>
          <button type="button" disabled={saving || stream !== 'live'} onClick={() => applyExposure(config, 'save')} className="min-h-11 w-full rounded-full bg-[var(--color-ink)] font-semibold text-[var(--color-on-ink)] disabled:opacity-50">{saving ? 'Applying…' : 'Apply exposure'}</button>
          {undoConfig && <button type="button" disabled={saving || stream !== 'live'} onClick={() => applyExposure(undoConfig, 'undo')} className="min-h-11 w-full rounded-full border border-[var(--color-border)] font-semibold disabled:opacity-50">Undo last change</button>}
          {message && <p role="status" className="text-sm text-[var(--color-text-secondary)]">{message}</p>}
        </aside>
      </div>
      <section aria-labelledby="saved-exposure-heading" className="mt-5 card-paper p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div><h2 id="saved-exposure-heading" className="text-lg font-semibold text-[var(--color-text-primary)]">Saved exposure zones</h2><p className="text-sm text-[var(--color-text-secondary)]">Keep named lighting setups with a visual reference.</p></div>
          <div className="flex w-full gap-2 sm:w-auto">
            <label className="min-w-0 flex-1"><span className="sr-only">Exposure zone name</span><input aria-label="Exposure zone name" maxLength={40} value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="e.g. Bright doorway" className="min-h-11 w-full rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-4" /></label>
            <button type="button" disabled={presetSaving || stream !== 'live'} onClick={savePreset} className="min-h-11 shrink-0 rounded-full bg-[var(--color-ink)] px-5 font-semibold text-[var(--color-on-ink)] disabled:opacity-50">{presetSaving ? 'Saving…' : 'Save zone'}</button>
          </div>
        </div>
        {presets.length === 0 ? <p className="mt-4 text-sm text-[var(--color-text-tertiary)]">No saved zones yet.</p> : <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{presets.map((preset) => <article key={preset.id} className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]"><img src={preset.thumbnail} alt={`Camera preview for ${preset.name}`} className="aspect-video w-full bg-black object-cover" /><div className="p-3"><h3 className="truncate font-semibold text-[var(--color-text-primary)]">{preset.name}</h3><p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{preset.config.enabled ? 'Selected area' : 'Whole image'} · {preset.config.compensation > 0 ? '+' : ''}{preset.config.compensation.toFixed(1)}</p><div className="mt-3 grid grid-cols-[1fr_auto] gap-2"><button type="button" disabled={saving || stream !== 'live'} onClick={() => applyExposure(preset.config, 'restore')} className="min-h-11 rounded-full bg-[var(--color-ink)] px-4 font-semibold text-[var(--color-on-ink)] disabled:opacity-50">Restore</button><button type="button" aria-label={`Delete ${preset.name}`} onClick={() => removePreset(preset)} className="min-h-11 rounded-full border border-[var(--color-border)] px-4 font-semibold">Delete</button></div></div></article>)}</div>}
      </section>
    </section>
  )
}
