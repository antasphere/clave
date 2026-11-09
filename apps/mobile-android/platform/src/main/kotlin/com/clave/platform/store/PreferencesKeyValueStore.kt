package com.clave.platform.store

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import com.clave.core.ports.KeyValueStore
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.flow.first

/**
 * [KeyValueStore] on DataStore Preferences, for settings, drafts, records and caches: never a
 * credential, which goes through [KeystoreSecureStore]. The file is
 * `filesDir/datastore/<name>.preferences_pb`, and one DataStore serves each name for the
 * whole process, so two stores of one name share it (DataStore refuses two on one file).
 */
class PreferencesKeyValueStore(context: Context, name: String = "clave.settings") : KeyValueStore {
    private val store: DataStore<Preferences> = STORES.computeIfAbsent(name) {
        val app = context.applicationContext
        PreferenceDataStoreFactory.create(produceFile = { File(app.filesDir, "datastore/$name.preferences_pb") })
    }

    override suspend fun get(key: String): String? = store.data.first()[stringPreferencesKey(key)]

    override suspend fun set(key: String, value: String) {
        store.edit { it[stringPreferencesKey(key)] = value }
    }

    override suspend fun remove(key: String) {
        store.edit { it.remove(stringPreferencesKey(key)) }
    }

    private companion object {
        val STORES = ConcurrentHashMap<String, DataStore<Preferences>>()
    }
}
