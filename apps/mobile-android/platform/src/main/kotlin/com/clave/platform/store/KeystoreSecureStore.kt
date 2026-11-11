package com.clave.platform.store

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.clave.core.ports.Log
import com.clave.core.ports.NoLog
import com.clave.core.ports.SecureStore
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * [SecureStore] on the Android Keystore. One AES-256 key under [alias], generated once and
 * never leaving the Keystore, encrypts every value with AES/GCM; the preferences file
 * [fileName] holds `base64(iv):base64(ciphertext)` under the key as given, never the
 * plaintext. A value that cannot be read back (a tampered or malformed entry, a key the
 * Keystore no longer holds) is removed and answered as absent: the person pairs again, the
 * app never crashes on it. The log names the key by its hash only.
 */
class KeystoreSecureStore(
    context: Context,
    private val log: Log = NoLog,
    fileName: String = "clave.secure",
    private val alias: String = "clave.secure.v1",
) : SecureStore {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences(fileName, Context.MODE_PRIVATE)

    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val entry = prefs.getString(key, null) ?: return@withContext null
        val plain = try {
            decrypt(entry)
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: ProviderException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
        if (plain == null) {
            prefs.edit().remove(key).commit()
            log.event("secure-store.unreadable", mapOf("key" to key.hashCode()))
        }
        plain
    }

    override suspend fun set(key: String, value: String) {
        withContext(Dispatchers.IO) {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val entry = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)
            prefs.edit().putString(key, entry).commit()
        }
    }

    override suspend fun remove(key: String) {
        withContext(Dispatchers.IO) { prefs.edit().remove(key).commit() }
    }

    private fun decrypt(entry: String): String? {
        val separator = entry.indexOf(':')
        if (separator <= 0 || separator == entry.length - 1) return null
        val iv = Base64.decode(entry.substring(0, separator), Base64.NO_WRAP)
        val sealed = Base64.decode(entry.substring(separator + 1), Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
        return String(cipher.doFinal(sealed), Charsets.UTF_8)
    }

    private fun key(): SecretKey = synchronized(KEY_LOCK) {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        /** Process-wide: two stores on one alias must not each generate a key. */
        val KEY_LOCK = Any()
    }
}
