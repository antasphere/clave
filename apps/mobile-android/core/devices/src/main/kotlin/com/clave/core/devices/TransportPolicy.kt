package com.clave.core.devices

import java.net.URI
import java.net.URISyntaxException

/**
 * Where a credential may travel (decision 4 of the spec, the rule of 29 October 2026): the
 * relay over HTTPS is the road, and a direct address is used only over https with a
 * certificate the platform validates. A release build never sends a device session, or any
 * credential, to a plain-HTTP address: out in town, a private address on a public network
 * can name someone else's machine. Plain HTTP to the loopback stays in the developer
 * connection of development builds, where a standalone server on this very machine (or the
 * emulator's host) is the point.
 */
public enum class BuildKind { Development, Release }

public sealed interface TransportVerdict {
    public val ok: Boolean

    public data object Allowed : TransportVerdict {
        override val ok: Boolean get() = true
    }

    public data class Refused(val reason: String) : TransportVerdict {
        override val ok: Boolean get() = false
    }
}

/** The two names the debug build's network security config lets the platform reach in clear
 *  (adb reverse lands on the phone's IPv4 loopback). The prototype also took the IPv6
 *  loopback; here the platform would refuse it, so the policy refuses it first. */
private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost")

public fun isLoopbackHost(hostname: String): Boolean = hostname.lowercase() in LOOPBACK_HOSTS

/** The parts of an address the policy reads, as WHATWG's URL names them: the scheme, the
 *  hostname (an IPv6 literal keeps its brackets) and the host (hostname plus port). */
internal class ParsedAddress(val scheme: String, val hostname: String?, val host: String)

internal fun parseAddress(url: String): ParsedAddress? {
    val uri = try {
        URI(url)
    } catch (_: URISyntaxException) {
        return null
    }
    val scheme = uri.scheme?.lowercase() ?: return null
    val hostname = uri.host?.lowercase()
    val host = when {
        hostname == null -> ""
        uri.port == -1 -> hostname
        else -> "$hostname:${uri.port}"
    }
    return ParsedAddress(scheme, hostname, host)
}

/** Whether a credential may be sent to [url] (http(s) or ws(s)) in this build. */
public fun credentialMayTravelTo(url: String, build: BuildKind): TransportVerdict {
    val parsed = parseAddress(url) ?: return TransportVerdict.Refused("\"$url\" is not an address.")
    val scheme = parsed.scheme
    val webScheme = scheme == "https" || scheme == "wss" || scheme == "http" || scheme == "ws"
    if (webScheme && parsed.hostname.isNullOrEmpty()) return TransportVerdict.Refused("\"$url\" is not an address.")
    if (scheme == "https" || scheme == "wss") return TransportVerdict.Allowed
    if (scheme == "http" || scheme == "ws") {
        if (build == BuildKind.Development && isLoopbackHost(parsed.hostname!!)) return TransportVerdict.Allowed
        return TransportVerdict.Refused(
            if (build == BuildKind.Development) {
                "Plain $scheme is allowed to 127.0.0.1 only in a development build; use https for ${parsed.host}."
            } else {
                "A credential never travels over plain $scheme (${parsed.host}); only https is used."
            },
        )
    }
    return TransportVerdict.Refused("\"$scheme:\" is not a scheme a credential travels over.")
}

/** The same verdict as a thrown error, for a constructor. */
public fun assertCredentialMayTravelTo(url: String, build: BuildKind) {
    val verdict = credentialMayTravelTo(url, build)
    if (verdict is TransportVerdict.Refused) throw TransportPolicyError(verdict.reason, url)
}

/** The address this build refuses to send a credential to. The address is no secret: it is
 *  what the person typed or what the relay listed. */
public class TransportPolicyError(message: String, public val url: String) : IllegalArgumentException(message)
