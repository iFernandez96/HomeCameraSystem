from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import struct
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from app.services.backup_manifest import BackupInventoryEntry, validate_manifest
from app.services.backup_crypto import decrypt_file, encrypt_chunks_to_file

_BACKUP_NAME_RE = re.compile(r"^homecam-backup-[0-9]{8}T[0-9]{6}Z\.tar\.gz$")
_ENCRYPTED_BACKUP_NAME_RE = re.compile(
    r"^homecam-backup-[0-9]{8}T[0-9]{6}Z\.hcbk$"
)
_BUNDLE_MAGIC = b"HCBNDL01"
_MAX_MANIFEST_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class BackupArchiveDraft:
    archive_tmp_path: Path
    manifest: dict[str, Any]


@dataclass(frozen=True)
class PublishedBackup:
    archive_path: Path
    manifest_path: Path
    archive_sha256: str


@dataclass(frozen=True)
class EncryptedPublishedBackup:
    archive_path: Path
    archive_sha256: str
    manifest_sha256: str


@dataclass(frozen=True)
class DecryptedBackupBundle:
    archive_path: Path
    manifest_path: Path
    manifest: dict[str, Any]
    cleanup_paths: tuple[Path, ...]


def backup_api_response_from_published(published: PublishedBackup) -> dict[str, object]:
    """Build the success response for an already-published archive."""
    if not published.archive_path.exists() or not published.archive_path.is_file():
        raise FileNotFoundError("published archive does not exist")
    if not published.manifest_path.exists() or not published.manifest_path.is_file():
        raise FileNotFoundError("published manifest does not exist")
    archive_digest = sha256_file(published.archive_path)
    if archive_digest != published.archive_sha256:
        raise ValueError("published archive digest does not match ledger")

    manifest_id = sha256_file(published.manifest_path)
    return {
        "ok": True,
        "filename": published.archive_path.name,
        "size": published.archive_path.stat().st_size,
        "manifest_id": manifest_id,
        "archive_digest": archive_digest,
        "ledger_id": archive_digest,
    }


def encrypted_backup_api_response(
    published: EncryptedPublishedBackup,
) -> dict[str, object]:
    if not published.archive_path.is_file():
        raise FileNotFoundError("published encrypted backup does not exist")
    archive_digest = sha256_file(published.archive_path)
    if archive_digest != published.archive_sha256:
        raise ValueError("published encrypted backup digest does not match")
    return {
        "ok": True,
        "filename": published.archive_path.name,
        "size": published.archive_path.stat().st_size,
        "manifest_id": published.manifest_sha256,
        "archive_digest": archive_digest,
        "encrypted": True,
        "ledger_id": archive_digest,
    }


def write_archive_to_temp(
    *,
    target_dir: Path,
    manifest: dict[str, Any],
    inventory: Iterable[BackupInventoryEntry],
    temp_stem: str = "homecam-backup",
) -> BackupArchiveDraft:
    """Write a backup tarball to a route-invisible temp file."""
    manifest = validate_manifest(manifest)
    target_dir.mkdir(parents=True, exist_ok=True)
    archive_tmp_path = target_dir / f"{temp_stem}.tar.gz.tmp~"
    _unlink_quiet(archive_tmp_path)

    entries_by_role = {entry.role: entry for entry in inventory}
    try:
        with tarfile.open(archive_tmp_path, "w:gz") as archive:
            for item in manifest["files"]:
                if item.get("absent", False):
                    continue
                entry = entries_by_role.get(item["role"])
                if entry is None:
                    raise ValueError(f"manifest role has no inventory entry: {item['role']}")
                archive.add(entry.path, arcname=item["path"], recursive=False)
    except Exception:
        _unlink_quiet(archive_tmp_path)
        raise

    enriched = dict(manifest)
    enriched["archive_sha256"] = sha256_file(archive_tmp_path)
    return BackupArchiveDraft(
        archive_tmp_path=archive_tmp_path,
        manifest=validate_manifest(enriched),
    )


def publish_backup_atomically(
    *,
    draft: BackupArchiveDraft,
    target_dir: Path,
    final_archive_name: str,
) -> PublishedBackup:
    """Publish temp archive and manifest with same-filesystem replaces."""
    if not _BACKUP_NAME_RE.match(final_archive_name):
        raise ValueError("final archive name is not a valid backup filename")
    target_dir.mkdir(parents=True, exist_ok=True)
    final_archive_path = target_dir / final_archive_name
    final_manifest_path = target_dir / f"{final_archive_name}.manifest.json"
    manifest_tmp_path = target_dir / f"{final_manifest_path.name}.tmp~"
    _unlink_quiet(manifest_tmp_path)

    try:
        payload = json.dumps(draft.manifest, sort_keys=True).encode("utf-8")
        manifest_tmp_path.write_bytes(payload)
        os.replace(str(manifest_tmp_path), str(final_manifest_path))
        os.replace(str(draft.archive_tmp_path), str(final_archive_path))
    except Exception:
        _unlink_quiet(manifest_tmp_path)
        _unlink_quiet(draft.archive_tmp_path)
        raise

    return PublishedBackup(
        archive_path=final_archive_path,
        manifest_path=final_manifest_path,
        archive_sha256=draft.manifest["archive_sha256"],
    )


def publish_encrypted_backup_atomically(
    *,
    draft: BackupArchiveDraft,
    target_dir: Path,
    final_archive_name: str,
    recipient_public_key_path: Path,
) -> EncryptedPublishedBackup:
    """Encrypt archive+manifest as one authenticated, atomic artifact."""
    if not _ENCRYPTED_BACKUP_NAME_RE.match(final_archive_name):
        raise ValueError("final encrypted backup name is invalid")
    target_dir.mkdir(parents=True, exist_ok=True)
    final_path = target_dir / final_archive_name
    encrypted_tmp = target_dir / f"{final_archive_name}.tmp~"
    _unlink_quiet(encrypted_tmp)
    published_here = False
    manifest_payload = json.dumps(
        validate_manifest(draft.manifest),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    manifest_sha256 = hashlib.sha256(manifest_payload).hexdigest()

    def plaintext_chunks() -> Iterable[bytes]:
        yield _BUNDLE_MAGIC
        yield struct.pack(">Q", len(manifest_payload))
        yield manifest_payload
        with draft.archive_tmp_path.open("rb") as archive:
            for chunk in iter(lambda: archive.read(1024 * 1024), b""):
                yield chunk

    try:
        if final_path.exists():
            raise FileExistsError("encrypted backup target already exists")
        encrypt_chunks_to_file(
            plaintext_chunks(),
            recipient_public_key_path=recipient_public_key_path,
            output_path=encrypted_tmp,
        )
        os.replace(encrypted_tmp, final_path)
        published_here = True
        os.chmod(final_path, 0o600)
    except Exception:
        _unlink_quiet(encrypted_tmp)
        if published_here:
            _unlink_quiet(final_path)
        raise
    finally:
        # The PR-201 tar is an intermediate only. It must not survive either a
        # successful publish or any key/encryption/publish failure.
        _unlink_quiet(draft.archive_tmp_path)

    return EncryptedPublishedBackup(
        archive_path=final_path,
        archive_sha256=sha256_file(final_path),
        manifest_sha256=manifest_sha256,
    )


def decrypt_encrypted_backup(
    *,
    encrypted_path: Path,
    recovery_private_key_path: Path,
    staging_parent: Path,
) -> DecryptedBackupBundle:
    """Authenticate an encrypted artifact and materialize bounded restore inputs."""
    staging_parent.mkdir(parents=True, exist_ok=True)
    token = hashlib.sha256(
        "{}:{}".format(encrypted_path, os.urandom(16).hex()).encode("utf-8")
    ).hexdigest()[:16]
    bundle_tmp = staging_parent / f".restore-{token}.bundle.tmp~"
    archive_tmp = staging_parent / f".restore-{token}.tar.gz.tmp~"
    manifest_tmp = staging_parent / f".restore-{token}.manifest.json.tmp~"
    for path in (bundle_tmp, archive_tmp, manifest_tmp):
        _unlink_quiet(path)
    try:
        decrypt_file(
            encrypted_path,
            recovery_private_key_path=recovery_private_key_path,
            output_path=bundle_tmp,
        )
        with bundle_tmp.open("rb") as bundle:
            if bundle.read(len(_BUNDLE_MAGIC)) != _BUNDLE_MAGIC:
                raise ValueError("decrypted backup bundle header is invalid")
            size_bytes = bundle.read(8)
            if len(size_bytes) != 8:
                raise ValueError("decrypted backup manifest length is missing")
            manifest_size = struct.unpack(">Q", size_bytes)[0]
            if manifest_size <= 0 or manifest_size > _MAX_MANIFEST_BYTES:
                raise ValueError("decrypted backup manifest length is invalid")
            manifest_payload = bundle.read(manifest_size)
            if len(manifest_payload) != manifest_size:
                raise ValueError("decrypted backup manifest is truncated")
            manifest = validate_manifest(json.loads(manifest_payload))
            fd = os.open(
                archive_tmp,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            try:
                with os.fdopen(fd, "wb") as archive_out:
                    shutil.copyfileobj(bundle, archive_out, length=1024 * 1024)
                    archive_out.flush()
                    os.fsync(archive_out.fileno())
            except Exception:
                _unlink_quiet(archive_tmp)
                raise
        if manifest.get("archive_sha256") != sha256_file(archive_tmp):
            raise ValueError("decrypted backup archive checksum mismatch")
        payload = json.dumps(
            manifest,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        fd = os.open(
            manifest_tmp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        try:
            _write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
    except Exception:
        for path in (bundle_tmp, archive_tmp, manifest_tmp):
            _unlink_quiet(path)
        raise
    _unlink_quiet(bundle_tmp)
    return DecryptedBackupBundle(
        archive_path=archive_tmp,
        manifest_path=manifest_tmp,
        manifest=manifest,
        cleanup_paths=(archive_tmp, manifest_tmp),
    )


def apply_backup_retention(
    *,
    target_dir: Path,
    keep_newest: int,
    protect: Path | None = None,
) -> list[Path]:
    """Delete old published backup archives, preserving invalid names."""
    if keep_newest < 0:
        raise ValueError("keep_newest must be non-negative")
    if not target_dir.exists():
        return []

    protect_resolved = protect.resolve() if protect is not None and protect.exists() else None
    candidates: list[Path] = []
    for child in target_dir.iterdir():
        if child.is_file() and (
            _BACKUP_NAME_RE.match(child.name)
            or _ENCRYPTED_BACKUP_NAME_RE.match(child.name)
        ):
            candidates.append(child)
    candidates.sort(key=lambda path: (path.stat().st_mtime, path.name), reverse=True)

    deleted: list[Path] = []
    for archive_path in candidates[keep_newest:]:
        if protect_resolved is not None and archive_path.resolve() == protect_resolved:
            continue
        archive_path.unlink()
        deleted.append(archive_path)
        manifest_path = archive_path.with_name(f"{archive_path.name}.manifest.json")
        if manifest_path.exists():
            manifest_path.unlink()
            deleted.append(manifest_path)
    return deleted


def remove_plaintext_backup_intermediates(target_dir: Path) -> list[Path]:
    """Remove only unpublished plaintext files owned by the backup pipeline."""
    if not target_dir.exists():
        return []
    removed: list[Path] = []
    for pattern in (
        "homecam-backup-*.tar.gz.tmp~",
        "homecam-backup-*.tar.gz.manifest.json.tmp~",
    ):
        for path in target_dir.glob(pattern):
            if path.is_file():
                path.unlink()
                removed.append(path)
    return removed


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _unlink_quiet(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    written = 0
    while written < len(view):
        count = os.write(fd, view[written:])
        if count <= 0:
            raise OSError("short write while materializing backup restore input")
        written += count
