package com.clave.android.developer

import com.clave.core.auth.IssuerResolution
import com.clave.core.auth.resolveIssuer
import com.clave.core.ports.KeyValueStore

/**
 * The development build's sign-in issuer override, kept in the plain store: a local test
 * provider instead of the Antasphere hub. Only what the core's issuer rule accepts is kept
 * (https, or http to the loopback); blank removes the override.
 */
object DevelopmentIssuer {
    const val KEY: String = "clave.development.issuer"

    /** The override, or null when none is kept. */
    suspend fun read(kv: KeyValueStore): String? = kv.get(KEY)?.trim()?.takeIf { it.isNotEmpty() }

    /** Why the issuer rule refuses [raw], or null when it accepts it (blank is the hub, accepted). */
    fun refusal(raw: String): String? = when (val resolved = resolveIssuer(raw.trim().takeIf { it.isNotEmpty() })) {
        is IssuerResolution.Ok -> null
        is IssuerResolution.Refused -> "That issuer is refused: ${resolved.reason}."
    }

    /** Keeps [raw] as the override, or removes it when blank. */
    suspend fun write(kv: KeyValueStore, raw: String) {
        val value = raw.trim()
        if (value.isEmpty()) kv.remove(KEY) else kv.set(KEY, value)
    }
}
