package fun.arcodian.wallet;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureVaultPlugin.class);
        super.onCreate(savedInstanceState);
        dispatchDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        dispatchDeepLink(intent);
    }

    private void dispatchDeepLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"arcodian".equals(data.getScheme())) return;
        String host = data.getHost();
        if (!("pay".equals(host) || "bridge".equals(host) || "agentpay".equals(host))) return;
        String encoded = URLEncoder.encode(data.toString(), StandardCharsets.UTF_8);
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl("https://localhost/?deeplink=" + encoded));
    }
}
