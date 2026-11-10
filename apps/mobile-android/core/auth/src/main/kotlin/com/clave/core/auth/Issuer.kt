package com.clave.core.auth

import java.net.URI
import java.net.URISyntaxException

/*
 * The issuer the phone signs in at: the hub, or a loopback provider named for a test.
 * The rule is the Mac's: an override is a bare origin, https, or plain http to the
 * literal 127.0.0.1 and nothing else; a refused override does NOT fall back to the hub,
 * so a build told to use a test provider can never reach production through a typo.
 */

const val DEFAULT_ISSUER: String = "https://account.antasphere.com"
const val SCOPE: String = "openid profile email offline_access"

/** The Android app's own scheme, distinct from the prototype's `clave://`; the host is not empty, as the hub's consent page requires. */
const val REDIRECT_URI: String = "clave-android://oauth/callback"
const val CLIENT_NAME: String = "Clave"

data class IssuerConfig(
    /** The issuer's origin, no trailing slash: `https://account.antasphere.com`. */
    val origin: String,
    /** Plain HTTP, allowed for the literal loopback test target and nothing else. */
    val insecure: Boolean,
)

sealed class IssuerResolution {
    data class Ok(val config: IssuerConfig) : IssuerResolution()
    data class Refused(val reason: String) : IssuerResolution()
}

fun resolveIssuer(raw: String?): IssuerResolution {
    val trimmed = raw?.trim()
    if (trimmed.isNullOrEmpty()) return IssuerResolution.Ok(IssuerConfig(DEFAULT_ISSUER, insecure = false))
    val uri = try {
        URI(trimmed)
    } catch (_: URISyntaxException) {
        return IssuerResolution.Refused("not a URL")
    }
    if (uri.scheme == null) return IssuerResolution.Refused("not a URL")
    if (uri.isOpaque) return IssuerResolution.Refused("not a bare origin")
    if (uri.host.isNullOrEmpty()) return IssuerResolution.Refused("not a URL")
    val path = uri.rawPath.orEmpty()
    if (uri.rawUserInfo != null || !uri.rawQuery.isNullOrEmpty() || !uri.rawFragment.isNullOrEmpty() ||
        (path != "" && path != "/")
    ) return IssuerResolution.Refused("not a bare origin")
    val origin = originOf(uri) ?: return IssuerResolution.Refused("not a URL")
    return when {
        uri.scheme.equals("https", ignoreCase = true) -> IssuerResolution.Ok(IssuerConfig(origin, insecure = false))
        uri.scheme.equals("http", ignoreCase = true) && uri.host == "127.0.0.1" ->
            IssuerResolution.Ok(IssuerConfig(origin, insecure = true))
        else -> IssuerResolution.Refused("plain http is only accepted for 127.0.0.1")
    }
}

/** The WHATWG origin of a URL (`scheme://host[:port]`, the default port omitted), or null when it has none. */
internal fun originOf(url: String): String? = try {
    originOf(URI(url))
} catch (_: URISyntaxException) {
    null
}

private fun originOf(uri: URI): String? {
    val scheme = uri.scheme?.lowercase() ?: return null
    val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
    val default = when (scheme) {
        "https" -> 443
        "http" -> 80
        else -> -1
    }
    val port = uri.port
    return if (port == -1 || port == default) "$scheme://$host" else "$scheme://$host:$port"
}
