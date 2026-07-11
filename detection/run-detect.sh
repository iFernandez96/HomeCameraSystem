#!/bin/bash
# Wrapper for detect.py that strips libargus / nvmedia / jetson-utils
# stderr noise before it reaches the systemd journal. The C-level
# warnings (nvbuf_utils, dmabuf_fd, gstBufferManager, [image] saves)
# bypass sys.stderr so we can't catch them from Python — filter them
# at the shell.
#
# Patterns:
#   nvbuf_utils: ...               libargus dmabuf release noise
#   dmabuf_fd N mapped entry...    same family
#   [gstreamer] gstBufferManager   buffer manager housekeeping
#   [image]  saved '...latest.jpg' the once-per-second latest-frame
#                                  snapshot from save_latest. Per-event
#                                  thumb_NNN.jpg saves stay (they're
#                                  diagnostically useful).
set -o pipefail
exec /usr/bin/python3 -u /home/israel/HomeCameraSystem/detection/detect.py 2>&1 \
    | grep --line-buffered -vE 'nvbuf_utils:|dmabuf_fd [0-9]+ mapped entry NOT found|\[gstreamer\] gstBufferManager|\[image\]  saved .[^ ]*latest\.jpg'
