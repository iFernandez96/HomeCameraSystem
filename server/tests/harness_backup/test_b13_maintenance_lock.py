import pytest


def test_given_active_restore_when_backup_update_or_write_starts_then_typed_conflict_is_raised():
    from app.services.backup_restore import MaintenanceConflict, MaintenanceLock

    lock = MaintenanceLock()

    with lock.acquire("restore"):
        for operation in ("backup", "restore", "update", "write"):
            with pytest.raises(MaintenanceConflict) as exc:
                lock.acquire(operation)
            assert exc.value.active_operation == "restore"
            assert exc.value.requested_operation == operation


def test_given_operation_released_when_next_operation_starts_then_lock_is_reusable():
    from app.services.backup_restore import MaintenanceLock

    lock = MaintenanceLock()

    with lock.acquire("backup"):
        assert lock.active_operation == "backup"

    with lock.acquire("restore"):
        assert lock.active_operation == "restore"
