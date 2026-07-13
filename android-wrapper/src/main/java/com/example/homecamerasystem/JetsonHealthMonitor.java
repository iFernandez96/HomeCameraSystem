package com.example.homecamerasystem;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.ActivityManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.TimeUnit;

final class JetsonHealthMonitor {
    static final int JOB_ID = 36655;
    private static final String PREFS = "homecam_health_monitor";
    static final String KEY_FAILURES = "consecutive_failures";
    static final String KEY_OFFLINE = "offline_notified";
    static final String KEY_LAST_CHECK_MS = "last_check_ms";
    static final String KEY_NEXT_CHECK_MS = "next_check_ms";
    static final String KEY_LAST_REACHABLE = "last_reachable";
    private static final String CHANNEL_ID = "homecam_system_health";
    private static final long HEALTHY_DELAY_MS = TimeUnit.MINUTES.toMillis(15);
    private static final long RETRY_DELAY_MS = TimeUnit.MINUTES.toMillis(1);
    private static final long OFFLINE_DELAY_MS = TimeUnit.MINUTES.toMillis(5);

    private JetsonHealthMonitor() {}

    static void start(Context context) {
        createChannel(context);
        schedule(context, 0L);
    }

    static void schedule(Context context, long delayMs) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        JobInfo job = new JobInfo.Builder(
            JOB_ID,
            new ComponentName(context, JetsonHealthJobService.class)
        )
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setMinimumLatency(Math.max(0L, delayMs))
            // One-off persisted jobs avoid JobScheduler's 15-minute periodic
            // floor. The deadline bounds ordinary scheduler deferral while
            // still letting Android batch work under Doze.
            .setOverrideDeadline(Math.max(TimeUnit.MINUTES.toMillis(2), delayMs + TimeUnit.MINUTES.toMillis(5)))
            .setPersisted(true)
            .build();
        int result = scheduler.schedule(job);
        if (result == JobScheduler.RESULT_SUCCESS) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putLong(KEY_NEXT_CHECK_MS, System.currentTimeMillis() + Math.max(0L, delayMs))
                .apply();
        }
    }

    static long check(Context context) {
        boolean reachable = probe(BuildConfig.HOMECAM_URL);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
            .putLong(KEY_LAST_CHECK_MS, System.currentTimeMillis())
            .putBoolean(KEY_LAST_REACHABLE, reachable)
            .apply();
        int failures = prefs.getInt(KEY_FAILURES, 0);
        boolean wasOffline = prefs.getBoolean(KEY_OFFLINE, false);
        JetsonHealthState.Transition transition =
            JetsonHealthState.evaluate(reachable, failures, wasOffline);

        if (reachable) {
            prefs.edit().putInt(KEY_FAILURES, 0).putBoolean(KEY_OFFLINE, false).apply();
            if (transition == JetsonHealthState.Transition.RECOVERED) {
                notify(context, 401, "Jetson is back online", "HomeCam is reachable again.");
            }
            return HEALTHY_DELAY_MS;
        }

        int nextFailures = failures + 1;
        boolean offline = wasOffline || transition == JetsonHealthState.Transition.OFFLINE;
        prefs.edit().putInt(KEY_FAILURES, nextFailures).putBoolean(KEY_OFFLINE, offline).apply();
        if (transition == JetsonHealthState.Transition.OFFLINE) {
            notify(
                context,
                400,
                "Jetson offline or unreachable",
                "The phone could not reach HomeCam through either Tailscale or the local network in two consecutive checks."
            );
        }
        return offline ? OFFLINE_DELAY_MS : RETRY_DELAY_MS;
    }

    static String statusJson(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean notificationsAllowed = Build.VERSION.SDK_INT < 33
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        ActivityManager activity = context.getSystemService(ActivityManager.class);
        boolean backgroundRestricted = Build.VERSION.SDK_INT >= 28
            && activity != null
            && activity.isBackgroundRestricted();
        PowerManager power = context.getSystemService(PowerManager.class);
        boolean batteryOptimizationExempt = power != null
            && power.isIgnoringBatteryOptimizations(context.getPackageName());
        try {
            return new JSONObject()
                .put("v", 1)
                .put("native_version", BuildConfig.VERSION_NAME)
                .put("last_check_ms", prefs.getLong(KEY_LAST_CHECK_MS, 0L))
                .put("next_check_ms", prefs.getLong(KEY_NEXT_CHECK_MS, 0L))
                .put("last_reachable", prefs.getBoolean(KEY_LAST_REACHABLE, false))
                .put("consecutive_failures", prefs.getInt(KEY_FAILURES, 0))
                .put("offline_notified", prefs.getBoolean(KEY_OFFLINE, false))
                .put("background_restricted", backgroundRestricted)
                .put("battery_optimization_exempt", batteryOptimizationExempt)
                .put("notifications_allowed", notificationsAllowed)
                .toString();
        } catch (Exception ignored) {
            return "{\"v\":1}";
        }
    }

    private static boolean probe(String baseUrl) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(new URL(baseUrl), "healthz");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(4_000);
            connection.setReadTimeout(4_000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return false;
            try (InputStream stream = connection.getInputStream()) {
                return stream.read() >= 0;
            }
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Camera system health",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Alerts when the Jetson becomes unreachable or recovers");
        manager.createNotificationChannel(channel);
    }

    private static void notify(Context context, int id, String title, String body) {
        if (
            Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
        ) {
            return;
        }
        Intent intent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            context,
            id,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new android.app.Notification.Builder(context, CHANNEL_ID)
            : new android.app.Notification.Builder(context);
        android.app.Notification notification = builder
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new android.app.Notification.BigTextStyle().bigText(body))
                .setContentIntent(pending)
                .setAutoCancel(true)
                .setCategory(android.app.Notification.CATEGORY_ERROR)
                .build();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(id, notification);
    }
}
