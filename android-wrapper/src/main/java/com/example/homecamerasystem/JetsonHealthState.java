package com.example.homecamerasystem;

/** Pure transition policy for the phone-owned Jetson health monitor. */
final class JetsonHealthState {
    static final int FAILURES_BEFORE_OFFLINE = 2;

    enum Transition {
        NONE,
        OFFLINE,
        RECOVERED
    }

    private JetsonHealthState() {}

    static Transition evaluate(boolean reachable, int previousFailures, boolean wasOffline) {
        if (reachable) {
            return wasOffline ? Transition.RECOVERED : Transition.NONE;
        }
        int failures = previousFailures + 1;
        if (!wasOffline && failures >= FAILURES_BEFORE_OFFLINE) {
            return Transition.OFFLINE;
        }
        return Transition.NONE;
    }
}
