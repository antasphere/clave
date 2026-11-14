package com.clave.core.transport

/**
 * Whether a read failed because the Mac's server does not offer it to this phone yet: a 403
 * of the device scope (a server before the shell's reads were allowed to phones), a 404 of a
 * route that server does not have, or its declared CapabilityUnavailable. The shell hides the
 * section with an "Update Clave on your Mac" line for these, and shows any other failure as
 * the error it is.
 */
public fun isUnsupportedRead(error: Throwable): Boolean {
    if (error !is ServerError) return false
    // A 403 on these reads is safe to show as "Update Clave on your Mac": the server answers a
    // paired phone 403 only for a path missing from its device allowlist (packages/server/src/
    // devices/scope.ts), and these paths are missing only from a Mac older than the reads.
    return error.kind == ServerError.Kind.Forbidden || error.status == 404 || error.capabilityUnavailable
}
