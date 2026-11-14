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
    return error.kind == ServerError.Kind.Forbidden || error.status == 404 || error.capabilityUnavailable
}
