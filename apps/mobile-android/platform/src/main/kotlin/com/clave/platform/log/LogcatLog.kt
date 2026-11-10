package com.clave.platform.log

import com.clave.core.ports.Log

/**
 * [Log] on Logcat, one debug line per event: `name key=value …`, under [tag], and nothing
 * at all when not [enabled] (a release build). Nothing is redacted here because callers pass
 * codes only: never a token, a bearer, a credential or a URL carrying one.
 */
class LogcatLog(private val enabled: Boolean, private val tag: String = "clave") : Log {
    override fun event(name: String, fields: Map<String, Any?>) {
        if (!enabled) return
        android.util.Log.d(tag, name + " " + fields.entries.joinToString(" ") { "${it.key}=${it.value}" })
    }
}
