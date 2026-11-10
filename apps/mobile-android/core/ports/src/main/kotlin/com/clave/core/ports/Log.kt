package com.clave.core.ports

/**
 * One line per boundary event, codes only: never a token, never a bearer URL, never the
 * text of a conversation or a server's own words. The app binds it to Logcat in debug
 * builds and to nothing in release builds.
 */
interface Log {
    fun event(name: String, fields: Map<String, Any?> = emptyMap())
}

object NoLog : Log {
    override fun event(name: String, fields: Map<String, Any?>) {}
}
