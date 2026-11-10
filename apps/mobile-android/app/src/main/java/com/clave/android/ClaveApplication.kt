package com.clave.android

import android.app.Application

/** The process: the services are built once here and reached through [services]. */
class ClaveApplication : Application() {
    /** Everything the activities, the push service and the receiver share. */
    lateinit var services: AppServices
        private set

    override fun onCreate() {
        super.onCreate()
        services = AppServices(this).also { it.start() }
    }
}
