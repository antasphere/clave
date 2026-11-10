package com.clave.core.transport

/**
 * What a client is handed to speak to one server: its base URL (`http://127.0.0.1:43201`, or
 * a relay road `https://relay.example/m/<machine>`) and the bearer. The client never stores
 * it; the credential store owns that. [toString] hides the bearer so a stray log or an
 * assertion message never prints it.
 */
public data class Credential(val serverUrl: String, val bearer: String) {
    override fun toString(): String = "Credential(serverUrl=$serverUrl, bearer=<hidden>)"
}
