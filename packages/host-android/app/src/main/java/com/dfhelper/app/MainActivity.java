package com.dfhelper.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Mobile shell for DragonFableHelper.
 *
 * <p>The whole application - UI, bot engine and the Ruffle bridge - is one web
 * bundle, the same one the desktop build runs. This Activity only has to put
 * it somewhere the game will talk to it.
 *
 * <p>That "somewhere" is the interesting part. DragonFable's loader fetches its
 * assets relative to its own origin and ExternalInterface is gated on script
 * access, so a page on a {@code file://} origin cannot drive the game. The
 * trick is to load our bundle from a path <em>under the game's own origin</em>
 * and serve that path out of the APK: the page's origin is then the game's
 * origin, while the bytes still come from local assets.
 */
public class MainActivity extends Activity {

    private static final String GAME_ORIGIN = "https://play.dragonfable.com";
    /** Path under the game origin that we serve from local assets. */
    private static final String APP_PATH = "/__dfh/";
    private static final String APP_URL = GAME_ORIGIN + APP_PATH + "index.html";
    /** Assets directory the Vite bundle is copied into (see build.gradle.kts). */
    private static final String ASSET_ROOT = "dfh";

    private WebView webView;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        goFullscreen();

        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);

        // AGP 8 stops generating BuildConfig unless the feature is switched on,
        // and the installed app's debuggable flag is the better signal anyway.
        // With this on you can attach Chrome DevTools to the WebView the bot
        // itself runs in.
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        webView.setBackgroundColor(Color.BLACK);
        webView.addJavascriptInterface(new WebAppInterface(), "AndroidHost");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new LocalAssetWebViewClient());

        webView.loadUrl(APP_URL);
    }

    /**
     * Serves {@link #APP_PATH} out of the APK and lets everything else - the
     * game's own traffic - go to the network untouched.
     */
    private class LocalAssetWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (!url.startsWith(GAME_ORIGIN + APP_PATH)) {
                return null; // not ours; let the network handle it
            }

            String relative = url.substring((GAME_ORIGIN + APP_PATH).length());
            int query = relative.indexOf('?');
            if (query >= 0) {
                relative = relative.substring(0, query);
            }
            if (relative.isEmpty()) {
                relative = "index.html";
            }
            // Refuse anything trying to climb out of the assets directory.
            if (relative.contains("..")) {
                return null;
            }

            try {
                InputStream stream = getAssets().open(ASSET_ROOT + "/" + relative);
                WebResourceResponse response =
                        new WebResourceResponse(mimeTypeOf(relative), "UTF-8", stream);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    Map<String, String> headers = new HashMap<>();
                    // Same-origin as the game, so the bot can reach into it.
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Cache-Control", "no-cache");
                    response.setResponseHeaders(headers);
                }
                return response;
            } catch (IOException missing) {
                return null;
            }
        }
    }

    private static String mimeTypeOf(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void goFullscreen() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    /** Small native surface the web bundle can call, mirroring the desktop preload. */
    private class WebAppInterface {
        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> webView.loadUrl(APP_URL));
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
