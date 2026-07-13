package com.example.homecamerasystem;

import android.annotation.SuppressLint;
import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedDispatcher;

@SuppressWarnings("deprecation") // Legacy back/system-bar APIs support minSdk 24.
public final class MainActivity extends Activity {
    private WebView webView;
    private LinearLayout recoveryView;
    private FrameLayout rootView;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean tailscaleLaunchPending = false;
    private boolean showingRecovery = false;
    private final android.os.Handler mainHandler =
        new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean activityResumed = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        rootView = new FrameLayout(this);
        // Debug builds expose the embedded WebView to chrome://inspect and
        // Chrome DevTools/Playwright over ADB. Release builds stay closed.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(35, 32, 25));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        applySystemBarPadding(webView, 0, 0, 0, 0);
        recoveryView = buildRecoveryView();
        rootView.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        setContentView(rootView);

        JetsonHealthMonitor.start(getApplicationContext());
        if (
            android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 9023);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(
            settings.getUserAgentString() + " HomeCamNative/" + BuildConfig.VERSION_NAME
        );

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                webView.setVisibility(View.GONE);
                rootView.addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                ));
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                );
            }

            @Override
            public void onHideCustomView() {
                exitVideoFullscreen();
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                refreshWebAppCaches(view);
            }

            @Override
            public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                android.webkit.WebResourceError error
            ) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) handleMainFrameLoadFailure();
            }
        });

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            loadTailnet();
        }

        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                this::handleBack
            );
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        ensureVpnConnected();
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (fullscreenView != null) {
            exitVideoFullscreen();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        moveTaskToBack(true);
    }

    private void loadTailnet() {
        showWebView();
        webView.loadUrl(BuildConfig.HOMECAM_URL);
    }

    private void handleMainFrameLoadFailure() {
        showingRecovery = true;
        setContentView(recoveryView);
    }

    private void showWebView() {
        showingRecovery = false;
        if (rootView == null) return;
        if (webView.getParent() == null) {
            rootView.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ));
        }
        setContentView(rootView);
    }

    private void exitVideoFullscreen() {
        if (fullscreenView == null) return;
        if (fullscreenView.getParent() instanceof ViewGroup) {
            ((ViewGroup) fullscreenView.getParent()).removeView(fullscreenView);
        }
        fullscreenView = null;
        webView.setVisibility(View.VISIBLE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
    }

    private void refreshWebAppCaches(WebView view) {
        String key = "homecam:native-cache-refresh:" + BuildConfig.VERSION_CODE;
        String js =
            "(async function(){"
                + "try{"
                + "var key='" + key + "';"
                + "if(sessionStorage.getItem(key)==='1')return;"
                + "sessionStorage.setItem(key,'1');"
                + "if('serviceWorker' in navigator){"
                + "var regs=await navigator.serviceWorker.getRegistrations();"
                + "await Promise.all(regs.map(function(r){return r.unregister();}));"
                + "}"
                + "if('caches' in window){"
                + "var names=await caches.keys();"
                + "await Promise.all(names.map(function(n){return caches.delete(n);}));"
                + "}"
                + "location.reload();"
                + "}catch(e){}"
                + "})();";
        view.evaluateJavascript(js, null);
    }

    private boolean isVpnActive() {
        ConnectivityManager connectivityManager =
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return false;
        Network activeNetwork = connectivityManager.getActiveNetwork();
        if (activeNetwork == null) return false;
        NetworkCapabilities capabilities =
            connectivityManager.getNetworkCapabilities(activeNetwork);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    private boolean isTailscaleInstalled() {
        return getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn") != null;
    }

    private void ensureVpnConnected() {
        boolean vpn = isVpnActive();
        if (vpn) {
            boolean wasWaiting = tailscaleLaunchPending || showingRecovery;
            tailscaleLaunchPending = false;
            if (wasWaiting) loadTailnet();
            return;
        }
        if (!tailscaleLaunchPending && isTailscaleInstalled()) {
            tailscaleLaunchPending = true;
            requestTailscaleConnect();
            // Fall back after both silent broadcast attempts if the tunnel is
            // still down and the wrapper remains in the foreground.
            mainHandler.postDelayed(() -> {
                if (activityResumed && !isVpnActive()) {
                    openTailscale();
                }
            }, 5000);
        }
    }

    private void requestTailscaleConnect() {
        Intent intent = new Intent("com.tailscale.ipn.CONNECT_VPN");
        intent.setClassName("com.tailscale.ipn", "com.tailscale.ipn.IPNReceiver");
        try {
            sendBroadcast(intent);
        } catch (Exception ignored) {
            // The delayed app-launch fallback covers a missing or changed receiver.
        }
        mainHandler.postDelayed(() -> {
            try {
                sendBroadcast(intent);
            } catch (Exception ignored) {
                // The delayed app-launch fallback covers a missing or changed receiver.
            }
        }, 2000);
    }

    private LinearLayout buildRecoveryView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(android.view.Gravity.CENTER);
        int pad = Math.round(28 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(Color.rgb(35, 32, 25));
        applySystemBarPadding(root, pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("HomeCam can't connect");
        title.setTextColor(Color.rgb(250, 246, 238));
        title.setTextSize(26);
        title.setGravity(android.view.Gravity.CENTER);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);

        TextView body = new TextView(this);
        body.setText("HomeCam requires its private Tailscale connection. Open Tailscale, confirm it is connected, then try again.");
        body.setTextColor(Color.rgb(188, 181, 166));
        body.setTextSize(16);
        body.setGravity(android.view.Gravity.CENTER);
        LinearLayout.LayoutParams bodyParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        bodyParams.setMargins(0, pad / 2, 0, pad);

        Button tailscale = new Button(this);
        tailscale.setText("Open Tailscale");
        tailscale.setAllCaps(false);
        tailscale.setOnClickListener(v -> openTailscale());

        Button retry = new Button(this);
        retry.setText("Try again");
        retry.setAllCaps(false);
        retry.setOnClickListener(v -> loadTailnet());

        root.addView(title);
        root.addView(body, bodyParams);
        root.addView(tailscale, buttonParams());
        root.addView(retry, buttonParams());
        return root;
    }

    private void applySystemBarPadding(
        View view,
        int baseLeft,
        int baseTop,
        int baseRight,
        int baseBottom
    ) {
        view.setOnApplyWindowInsetsListener((v, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                v.setPadding(
                    baseLeft + bars.left,
                    baseTop + bars.top,
                    baseRight + bars.right,
                    baseBottom + bars.bottom
                );
            } else {
                v.setPadding(
                    baseLeft + insets.getSystemWindowInsetLeft(),
                    baseTop + insets.getSystemWindowInsetTop(),
                    baseRight + insets.getSystemWindowInsetRight(),
                    baseBottom + insets.getSystemWindowInsetBottom()
                );
            }
            return insets;
        });
        view.requestApplyInsets();
    }

    private LinearLayout.LayoutParams buttonParams() {
        int top = Math.round(10 * getResources().getDisplayMetrics().density);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        params.setMargins(0, top, 0, 0);
        return params;
    }

    private void openTailscale() {
        Intent launch = getPackageManager().getLaunchIntentForPackage("com.tailscale.ipn");
        if (launch == null) {
            launch = new Intent(android.provider.Settings.ACTION_VPN_SETTINGS);
        }
        try {
            startActivity(launch);
        } catch (ActivityNotFoundException ignored) {
            startActivity(new Intent(android.provider.Settings.ACTION_SETTINGS));
        }
    }
}
