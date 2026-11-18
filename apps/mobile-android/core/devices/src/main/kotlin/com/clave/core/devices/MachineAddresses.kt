package com.clave.core.devices

import java.net.URI
import java.net.URISyntaxException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * One address the phone asks for machines: a relay of the team, or any server that answers
 * the relay's `GET /machines`. [url] is an origin without a trailing slash; [name] is what
 * the person called it, null when they gave none.
 */
public data class MachineAddress(val url: String, val name: String? = null) {
    /** What a screen shows for the address: its name, or the host it points at. */
    val label: String get() = name ?: (parseAddress(url)?.host?.takeIf { it.isNotEmpty() } ?: url)
}

/**
 * The address as it is kept: [input] trimmed, without a trailing slash, an origin only (no
 * path, no query, no fragment), and one this build sends a credential to. Throws an
 * [IllegalArgumentException] whose message is a sentence to show.
 */
public fun normalizeMachineAddress(input: String, build: BuildKind): String {
    val url = input.trim().trimEnd('/')
    val parsed = try {
        URI(url)
    } catch (e: URISyntaxException) {
        throw IllegalArgumentException("\"$url\" is not an address.", e)
    }
    assertCredentialMayTravelTo(url, build)
    val path = parsed.rawPath.orEmpty()
    if ((path != "" && path != "/") || parsed.rawQuery != null || parsed.rawFragment != null) {
        throw IllegalArgumentException("Enter the address as an origin, without a path or query.")
    }
    return url
}

/** The list as JSON: `[{"url": .., "name": ..}]`, the name left out when there is none. */
public fun encodeMachineAddresses(addresses: List<MachineAddress>): String = buildJsonArray {
    for (a in addresses) add(
        buildJsonObject {
            put("url", a.url)
            if (a.name != null) put("name", a.name)
        },
    )
}.toString()

/** The list as it was written. An entry without a url is dropped, and so is a second entry
 *  with a url already read (the first wins); a value that is not a list is no address. */
public fun decodeMachineAddresses(raw: String): List<MachineAddress> {
    val parsed = parseJsonOrNull(raw) as? JsonArray ?: return emptyList()
    val seen = HashSet<String>()
    return parsed.mapNotNull { element ->
        val o = element.objectOrNull() ?: return@mapNotNull null
        val url = o["url"].stringOrNull()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        if (!seen.add(url)) return@mapNotNull null
        MachineAddress(url, o["name"].stringOrNull()?.takeIf { it.isNotBlank() })
    }
}

/**
 * What one address gave in a listing: the ids of the machines it listed, in its order
 * (also those another address listed first), and the sentence of its failure when it
 * could not be read. [fromCache] says its machines are the last ones it listed, all
 * offline, because it is out of reach right now. [pending] says it has not answered yet:
 * a listing published before every address answered.
 */
public data class AddressListing(
    val address: MachineAddress,
    val machineIds: List<String>,
    val error: String?,
    val fromCache: Boolean,
    val pending: Boolean = false,
)

/** Every machine the phone may reach, one row per id, and how each address answered. */
public data class MachineListing(val machines: List<Machine>, val addresses: List<AddressListing>)

/** A machine source read across several addresses: [listing] says what each one gave, and
 *  one address that fails, or is slow, never hides the machines of the others: [progress]
 *  hears the listing again each time one more address answers, before the last one does. */
public interface MachineDirectory : MachineSource {
    public suspend fun listing(progress: suspend (MachineListing) -> Unit = {}): MachineListing

    override suspend fun list(): List<Machine> = listing().machines
}
