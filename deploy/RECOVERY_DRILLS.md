# Recovery drills

`deploy/recovery-drill.sh` packages the recurring server-restart, disk-floor,
session-revocation, and MediaMTX recovery exercises. It prints its actions by
default and changes nothing:

```sh
./deploy/recovery-drill.sh --dry-run all
```

Run one drill during a maintenance window only after checking that the unit
names and `HOMECAM_BASE_URL` match the target:

```sh
export HOMECAM_DRILL_CONFIRM=YES
export HOMECAM_BASE_URL=http://127.0.0.1:8000
./deploy/recovery-drill.sh --execute media
```

The disk drill deliberately uses temporary-directory tests rather than filling
the recording filesystem. The session drill uses the test fixtures and never
revokes a production session. Server and media execution are disruptive and
therefore require the explicit confirmation variable.
