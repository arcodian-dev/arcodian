package fun.arcodian.wallet;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureVault")
public class SecureVaultPlugin extends Plugin {
    private static final String KEY_ALIAS = "arcodian_wallet_vault_v1";
    private static final String PREFS = "arcodian_secure_vault";
    private static final String ENTRY = "encrypted_wallet";

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void save(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null || secret.isEmpty()) { call.reject("Secret is required"); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8));
            String payload = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ENTRY, payload).apply();
            call.resolve();
        } catch (Exception error) { call.reject("Secure storage failed", error); }
    }

    @PluginMethod
    public void load(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String payload = prefs.getString(ENTRY, null);
            JSObject result = new JSObject();
            if (payload == null) { result.put("secret", null); call.resolve(result); return; }
            String[] parts = payload.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] clear = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            result.put("secret", new String(clear, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("Secure wallet could not be unlocked", error); }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(ENTRY).apply();
        call.resolve();
    }

    @PluginMethod
    public void biometricStatus(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL);
        JSObject value = new JSObject();
        value.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(value);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String reason = call.getString("reason", "Unlock Arcodian Wallet");
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(getActivity(), ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    JSObject value = new JSObject(); value.put("authenticated", true); call.resolve(value);
                }
                @Override public void onAuthenticationError(int code, CharSequence message) {
                    call.reject(message.toString());
                }
            });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("Arcodian Wallet")
                .setSubtitle(reason)
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build();
            prompt.authenticate(info);
        });
    }
}
