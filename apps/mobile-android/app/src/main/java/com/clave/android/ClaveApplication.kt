package com.clave.android

import android.app.Application

/** The process: the services are built once here and reached through [services]. */
class ClaveApplication : Application() {
    override fun onCreate() {
        super.onCreate()
    }
}
