package com.clave.core.transport

import com.clave.core.contract.ServerFailure

/**
 * Why a call to a Clave server did not answer what was asked (`apps/mobile/src/api/errors.ts`).
 * The message is the sentence to show: the server's own words on a refusal, ours otherwise.
 * It never carries the bearer or an Authorization header, so it is safe in a log line.
 */
public class ServerError(
    public val kind: Kind,
    message: String,
    public val status: Int? = null,
    /** The declared failure of a refusal (a 422), when there is one. */
    public val failure: ServerFailure? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    public enum class Kind {
        /** 401: the bearer is not this server's. */
        Unauthenticated,

        /**
         * 403: the route lies outside the scope the server grants this credential (a device
         * session is an allowlist, docs/mobile-pairing.md "The scope"). It is a boundary,
         * not a fault: never retried, never retried with another credential, never read as
         * a network problem.
         */
        Forbidden,

        /** 422 with a declared failure (or a 413 on an upload): the server's own words. */
        Refused,

        /** The request never completed: no route, a reset, an offline phone. */
        Network,

        /** The deadline passed before an answer. */
        Timeout,

        /** The server answered something this client does not read. */
        Protocol,

        /** The address is not one this build sends a credential to (TransportPolicy.kt). */
        Policy,
    }

    /** True when the server said it lacks the part (`CapabilityUnavailable`). */
    public val capabilityUnavailable: Boolean get() = failure?.tag == "CapabilityUnavailable"

    override fun toString(): String = "ServerError($kind${status?.let { ", $it" } ?: ""}): $message"

    public companion object {
        /** The sentence a 403 shows when the server's body names none. */
        public const val FORBIDDEN_FALLBACK: String = "This phone may not do that on the machine."

        /** The sentence to show for any error a call threw. */
        public fun messageOf(error: Throwable): String = error.message ?: error.toString()
    }
}

/** The sentence to show for any error a call threw. */
public fun messageOf(error: Throwable): String = ServerError.messageOf(error)
