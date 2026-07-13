from __future__ import annotations

import argparse
from pathlib import Path

from app.services.backup_crypto import (
    generate_recovery_keypair,
    recipient_fingerprint,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an off-Jetson HomeCam backup recovery key pair.",
    )
    parser.add_argument("--private-key", required=True, type=Path)
    parser.add_argument("--public-key", required=True, type=Path)
    args = parser.parse_args()
    generate_recovery_keypair(
        private_key_path=args.private_key,
        public_key_path=args.public_key,
    )
    print("recipient_fingerprint={}".format(recipient_fingerprint(args.public_key)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
