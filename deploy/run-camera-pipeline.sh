#!/usr/bin/env bash
set -euo pipefail

RTSP_PORT="${RTSP_PORT:-8554}"
EXPOSURE_CONFIG="${HOMECAM_EXPOSURE_CONFIG:-/home/israel/HomeCameraSystem/.camera-exposure.env}"
PRIVACY_CONFIG="${HOMECAM_PRIVACY_CONFIG:-/home/israel/HomeCameraSystem/.privacy-masks.env}"
AE_REGION=""
AE_COMPENSATION="0.0"
AE_LOCK="false"
AE_SENSOR_WIDTH="1920"
AE_SENSOR_HEIGHT="1080"
if [[ -r "$EXPOSURE_CONFIG" ]]; then
    # This file is written by the detection worker from strictly bounded
    # numeric/boolean API fields; it never contains arbitrary shell input.
    # shellcheck disable=SC1090
    source "$EXPOSURE_CONFIG"
fi
# Exposure files written before the 1440p30 migration store their Argus region
# in the old 1920x1080 sensor space. Scale that trusted, bounded shape in
# memory so the first boot after an upgrade meters the same normalized area.
if [[ -n "$AE_REGION" ]]; then
    read -r ae_left ae_top ae_right ae_bottom ae_weight <<< "$AE_REGION"
    if [[ "$AE_REGION" =~ ^[0-9]{1,4}\ [0-9]{1,4}\ [0-9]{1,4}\ [0-9]{1,4}\ 1$ ]] \
        && (( ae_left < ae_right && ae_top < ae_bottom )); then
        if [[ "$AE_SENSOR_WIDTH,$AE_SENSOR_HEIGHT" == "1920,1080" ]] \
            && (( ae_right <= 1920 && ae_bottom <= 1080 )); then
            AE_REGION="$((ae_left * 2)) $((ae_top * 2)) $((ae_right * 2)) $((ae_bottom * 2)) 1"
        elif [[ "$AE_SENSOR_WIDTH,$AE_SENSOR_HEIGHT" != "3840,2160" ]] \
            || (( ae_right > 3840 || ae_bottom > 2160 )); then
            echo "[camera] invalid exposure coordinate basis; using whole-frame metering" >&2
            AE_REGION=""
        fi
    else
        echo "[camera] invalid exposure region; using whole-frame metering" >&2
        AE_REGION=""
    fi
fi
# Fail closed until the detection worker has explicitly reconciled the live
# configuration.  On a first boot MediaMTX starts before homecam-detect, so a
# missing/unreadable file must produce a black frame instead of briefly
# publishing (and continuously recording) unredacted pixels.  The worker
# writes an explicit `PRIVACY_RECTS=''` when no masks are configured.
PRIVACY_RECTS="0,0,1920,1080"

privacy_rects_valid() {
    local value="$1" rect x y width height x_num y_num width_num height_num
    [[ -z "$value" ]] && return 0
    IFS=';' read -ra rects <<< "$value"
    for rect in "${rects[@]}"; do
        IFS=',' read -r x y width height <<< "$rect"
        [[ "$x,$y,$width,$height" =~ ^[0-9]{1,4},[0-9]{1,4},[1-9][0-9]{0,3},[1-9][0-9]{0,3}$ ]] || return 1
        x_num=$((10#$x))
        y_num=$((10#$y))
        width_num=$((10#$width))
        height_num=$((10#$height))
        (( x_num < 1920 && y_num < 1080 \
            && width_num <= 1920 - x_num \
            && height_num <= 1080 - y_num )) || return 1
    done
}

if [[ -r "$PRIVACY_CONFIG" ]]; then
    # Parse the exact generated one-assignment format instead of sourcing a
    # shell fragment.  A truncated/corrupt file stays on the full-frame
    # default; only a valid explicit empty assignment means "no masks".
    privacy_content="$(<"$PRIVACY_CONFIG")"
    privacy_rect_pattern='[0-9]{1,4},[0-9]{1,4},[1-9][0-9]{0,3},[1-9][0-9]{0,3}'
    privacy_file_pattern="^PRIVACY_RECTS='((${privacy_rect_pattern})(;${privacy_rect_pattern})*)?'$"
    if [[ "$privacy_content" =~ $privacy_file_pattern ]]; then
        privacy_candidate="${BASH_REMATCH[1]}"
    else
        privacy_candidate="__invalid__"
    fi
    if [[ "$privacy_candidate" != "__invalid__" ]] \
        && privacy_rects_valid "$privacy_candidate"; then
        PRIVACY_RECTS="$privacy_candidate"
    else
        echo "[camera] invalid privacy config; applying full-frame mask" >&2
    fi
else
    echo "[camera] privacy config unavailable; applying full-frame mask" >&2
fi
SOURCE_ARGS=(sensor-mode=0 exposurecompensation="$AE_COMPENSATION" aelock="$AE_LOCK")
if [[ -n "$AE_REGION" ]]; then
    SOURCE_ARGS+=(aeregion="$AE_REGION")
fi
CAMERA_SOURCE=(nvarguscamerasrc "${SOURCE_ARGS[@]}")

# One libargus camera owner at the sensor-native 4K30 mode, scaled in NVMM to
# one shared 1440p30 surface. Detection reads only /cam (720p30); viewers
# explicitly selecting UHQ plus Focus/Exposure Assistant read /cam_uhq
# (1440p30). Three-buffer leaky queues bound each encoded branch to about
# 16 MiB of 1440p NV12 references instead of allowing latency/memory growth.
echo "[camera] 4K30 sensor -> 720p30 detection/HQ + 1440p30 UHQ"
# A complete mask does not need a camera frame at all.  Publishing a generated
# black NV12 surface is both the strongest fail-closed behavior and avoids
# acquiring the fragile JetPack 4.x Argus session while Privacy mode is active.
# This also covers the missing/corrupt-config startup default above.
if [[ "$PRIVACY_RECTS" == "0,0,1920,1080" ]]; then
    echo "[camera] applying full-frame privacy mask without opening camera"
    exec gst-launch-1.0 -e \
        videotestsrc pattern=black is-live=true ! \
        'video/x-raw,width=2560,height=1440,framerate=30/1' ! nvvidconv ! \
        'video/x-raw(memory:NVMM),format=NV12,width=2560,height=1440,framerate=30/1' ! tee name=camera \
        camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! nvvidconv ! \
        'video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1' ! \
        nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=2500000 vbv-size=2500000 peak-bitrate=3000000 EnableTwopassCBR=false maxperf-enable=true ! \
        h264parse ! watchdog timeout=5000 ! rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam" \
        camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
        nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=8000000 vbv-size=8000000 peak-bitrate=9600000 EnableTwopassCBR=false maxperf-enable=true ! \
        h264parse ! watchdog timeout=5000 ! rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam_uhq"
fi
if [[ -n "$PRIVACY_RECTS" ]]; then
    compositor_props=(background=1 sink_0::zorder=0)
    overlay_inputs=()
    pad=1
    IFS=';' read -ra rects <<< "$PRIVACY_RECTS"
    for rect in "${rects[@]}"; do
        IFS=',' read -r x y width height <<< "$rect"
        # Privacy files intentionally remain in their durable 1920x1080
        # coordinate contract. Scale left/top down and right/bottom up so the
        # 1440p compositor covers at least the same normalized area.
        source_right=$((10#$x + 10#$width))
        source_bottom=$((10#$y + 10#$height))
        x=$((10#$x * 4 / 3))
        y=$((10#$y * 4 / 3))
        scaled_right=$(( (source_right * 4 + 2) / 3 ))
        scaled_bottom=$(( (source_bottom * 4 + 2) / 3 ))
        width=$((scaled_right - x))
        height=$((scaled_bottom - y))
        compositor_props+=("sink_${pad}::xpos=$x" "sink_${pad}::ypos=$y" "sink_${pad}::width=$width" "sink_${pad}::height=$height" "sink_${pad}::zorder=$pad")
        overlay_inputs+=(videotestsrc pattern=black is-live=true ! "video/x-raw,width=$width,height=$height,framerate=30/1" ! nvvidconv ! "video/x-raw(memory:NVMM),format=RGBA,width=$width,height=$height,framerate=30/1" ! "privacy.sink_${pad}")
        pad=$((pad + 1))
    done
    echo "[camera] applying $((pad - 1)) recording-time privacy rectangle(s) in NVMM"
    exec gst-launch-1.0 -e \
        nvcompositor name=privacy "${compositor_props[@]}" ! \
        nvvidconv ! \
        'video/x-raw(memory:NVMM),format=NV12,width=2560,height=1440,framerate=30/1' ! tee name=camera \
        camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! nvvidconv ! \
        'video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1' ! \
        nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=2500000 vbv-size=2500000 peak-bitrate=3000000 EnableTwopassCBR=false maxperf-enable=true ! \
        h264parse ! watchdog timeout=5000 ! rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam" \
        camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
        nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=8000000 vbv-size=8000000 peak-bitrate=9600000 EnableTwopassCBR=false maxperf-enable=true ! \
        h264parse ! watchdog timeout=5000 ! rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam_uhq" \
        "${CAMERA_SOURCE[@]}" ! \
        'video/x-raw(memory:NVMM),width=3840,height=2160,framerate=30/1' ! \
        queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! nvvidconv ! \
        'video/x-raw(memory:NVMM),format=RGBA,width=2560,height=1440,framerate=30/1' ! privacy.sink_0 \
        "${overlay_inputs[@]}"
fi
exec gst-launch-1.0 -e \
    "${CAMERA_SOURCE[@]}" ! \
    'video/x-raw(memory:NVMM),width=3840,height=2160,framerate=30/1' ! \
    nvvidconv ! \
    'video/x-raw(memory:NVMM),format=NV12,width=2560,height=1440,framerate=30/1' ! \
    tee name=camera \
    camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! nvvidconv ! \
    'video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1' ! \
    nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=2500000 vbv-size=2500000 peak-bitrate=3000000 EnableTwopassCBR=false maxperf-enable=true ! \
    h264parse ! watchdog timeout=5000 ! \
    rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam" \
    camera. ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
    nvv4l2h264enc insert-sps-pps=true iframeinterval=8 control-rate=1 bitrate=8000000 vbv-size=8000000 peak-bitrate=9600000 EnableTwopassCBR=false maxperf-enable=true ! \
    h264parse ! watchdog timeout=5000 ! \
    rtspclientsink protocols=tcp location="rtsp://localhost:${RTSP_PORT}/cam_uhq"
