package com.clave.core.ports

/** Epoch milliseconds. Injected so every race in the tests runs on a clock the test owns. */
fun interface Clock {
    fun now(): Long
}

object SystemClock : Clock {
    override fun now(): Long = System.currentTimeMillis()
}
