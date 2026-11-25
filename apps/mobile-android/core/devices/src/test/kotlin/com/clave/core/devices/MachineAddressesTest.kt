package com.clave.core.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The machine addresses as the person types them and as the phone keeps them. */
class MachineAddressesTest {
    private fun refused(input: String, build: BuildKind = BuildKind.Release): IllegalArgumentException {
        try {
            normalizeMachineAddress(input, build)
        } catch (e: IllegalArgumentException) {
            return e
        }
        fail("\"$input\" must be refused")
        throw AssertionError()
    }

    @Test
    fun `an address is kept trimmed, as an origin without its trailing slash`() {
        assertEquals("https://relay.example", normalizeMachineAddress("  https://relay.example/ ", BuildKind.Release))
        assertEquals("https://relay.example:8443", normalizeMachineAddress("https://relay.example:8443//", BuildKind.Release))
        assertEquals("http://127.0.0.1:4711", normalizeMachineAddress("http://127.0.0.1:4711/", BuildKind.Development))
    }

    @Test
    fun `a path, a query or a fragment is refused with the sentence that says so`() {
        val sentence = "Enter the address as an origin, without a path or query."
        assertEquals(sentence, refused("https://relay.example/team").message)
        assertEquals(sentence, refused("https://relay.example?x=1").message)
        assertEquals(sentence, refused("https://relay.example/#top").message)
    }

    @Test
    fun `something that is not an address, or one a credential never travels to, is refused`() {
        assertEquals("\"https://relay example\" is not an address.", refused("https://relay example").message)
        assertEquals("\"\" is not an address.", refused("   ").message)
        val plain = refused("http://relay.example")
        assertTrue(plain is TransportPolicyError)
        assertEquals("A credential never travels over plain http (relay.example); only https is used.", plain.message)
        // A development build reaches the loopback in clear, nothing else.
        assertTrue(refused("http://192.168.1.10", BuildKind.Development) is TransportPolicyError)
    }

    @Test
    fun `the list survives a round trip, a name left out when there is none`() {
        val addresses = listOf(MachineAddress("https://relay.example", "Team"), MachineAddress("https://home.example"))
        val raw = encodeMachineAddresses(addresses)
        assertEquals("""[{"url":"https://relay.example","name":"Team"},{"url":"https://home.example"}]""", raw)
        assertEquals(addresses, decodeMachineAddresses(raw))
        assertEquals(emptyList<MachineAddress>(), decodeMachineAddresses(encodeMachineAddresses(emptyList())))
    }

    @Test
    fun `decoding drops malformed entries and a second entry of one url, the first wins`() {
        val raw = """[
            {"url":"https://a.example","name":"First"},
            {"name":"no url"},
            {"url":""},
            {"url":5},
            "https://b.example",
            null,
            {"url":"https://a.example","name":"Second"},
            {"url":"https://c.example","name":"  "},
            {"url":"https://d.example","name":7}
        ]"""
        assertEquals(
            listOf(
                MachineAddress("https://a.example", "First"),
                MachineAddress("https://c.example"),
                MachineAddress("https://d.example"),
            ),
            decodeMachineAddresses(raw),
        )
        assertEquals(emptyList<MachineAddress>(), decodeMachineAddresses("not json"))
        assertEquals(emptyList<MachineAddress>(), decodeMachineAddresses("""{"url":"https://a.example"}"""))
    }

    @Test
    fun `an address is labelled by its name, or by the host it points at`() {
        assertEquals("Team", MachineAddress("https://relay.example", "Team").label)
        assertEquals("relay.example", MachineAddress("https://relay.example").label)
        assertEquals("127.0.0.1:4711", MachineAddress("http://127.0.0.1:4711").label)
    }
}
