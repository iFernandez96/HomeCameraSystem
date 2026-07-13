package com.example.homecamerasystem;

import android.content.Context;
import android.webkit.JavascriptInterface;

/** Read-only bridge for app-owned diagnostics. No credentials cross it. */
final class NativeStatusBridge {
    private final Context context;

    NativeStatusBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public String getHealthMonitorStatus() {
        return JetsonHealthMonitor.statusJson(context);
    }
}
