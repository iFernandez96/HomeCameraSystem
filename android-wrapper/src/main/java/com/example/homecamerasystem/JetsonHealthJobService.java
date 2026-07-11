package com.example.homecamerasystem;

import android.app.job.JobParameters;
import android.app.job.JobService;

public final class JetsonHealthJobService extends JobService {
    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            long nextDelay = JetsonHealthMonitor.check(getApplicationContext());
            jobFinished(params, false);
            JetsonHealthMonitor.schedule(getApplicationContext(), nextDelay);
        }, "homecam-health-check").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
