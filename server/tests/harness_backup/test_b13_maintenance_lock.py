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


def test_given_active_restore_when_state_is_read_then_typed_state_blocks_mutations():
    from app.services.backup_restore import MaintenanceLock

    lock = MaintenanceLock()

    with lock.acquire("restore"):
        assert lock.snapshot().response() == {
            "active": True,
            "operation": "restore",
            "blocks_mutations": True,
        }

    assert lock.snapshot().response() == {
        "active": False,
        "operation": None,
        "blocks_mutations": False,
    }


def test_given_ordinary_mutation_when_restore_starts_then_typed_conflict_is_raised():
    from app.services.backup_restore import MaintenanceConflict, MaintenanceLock

    lock = MaintenanceLock()

    with lock.acquire_mutation("POST /api/events/seen_all"):
        with pytest.raises(MaintenanceConflict) as exc_info:
            lock.acquire("restore")

    assert exc_info.value.response() == {
        "code": "maintenance_conflict",
        "active_operation": "ordinary_mutation",
        "requested_operation": "restore",
        "retryable": True,
    }


def test_given_stale_process_state_when_lifespan_restarts_then_state_is_cleared():
    from app.services.backup_restore import MaintenanceLock

    lock = MaintenanceLock()
    lease = lock.acquire("restore")
    assert lock.snapshot().active

    lock.reset_for_startup()

    assert not lock.snapshot().active
    with lock.acquire_mutation("POST /api/events/seen_all"):
        pass
    # Releasing a pre-restart lease after reset is harmless.
    lease.__exit__(None, None, None)
