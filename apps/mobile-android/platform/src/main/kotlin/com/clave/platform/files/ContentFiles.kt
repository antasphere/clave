package com.clave.platform.files

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import com.clave.core.chat.PickedFile
import com.clave.core.chat.PickedKind
import com.clave.core.chat.kindOf
import com.clave.core.chat.mimeTypeOf
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A picked file through the content resolver: what it is ([describe], before anything is
 * read) and its bytes as base64 under a ceiling ([readBase64], never more than the ceiling
 * held in memory), plus the camera's target under `cacheDir/camera/`, shared through the
 * app's FileProvider. A file that cannot be opened reads as null, never as a crash.
 */
class ContentFiles(private val context: Context) {
    suspend fun describe(uri: Uri, kindHint: PickedKind? = null): PickedFile? = withContext(Dispatchers.IO) {
        var name: String? = null
        var size: Long? = null
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameColumn >= 0 && !cursor.isNull(nameColumn)) name = cursor.getString(nameColumn)
                    val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
                }
            }
        } catch (_: SecurityException) {
            return@withContext null
        } catch (_: IllegalArgumentException) {
            // A file:// Uri or a provider without these columns: the path names the file.
        }
        val fileName = name?.takeIf { it.isNotEmpty() } ?: uri.lastPathSegment?.takeIf { it.isNotEmpty() } ?: return@withContext null
        val mimeType = context.contentResolver.getType(uri) ?: mimeTypeOf(fileName)
        PickedFile(uri = uri.toString(), name = fileName, mimeType = mimeType, size = size, kind = kindHint ?: kindOf(mimeType))
    }

    suspend fun readBase64(uri: Uri, maxBytes: Long): String? = withContext(Dispatchers.IO) {
        try {
            val stream = context.contentResolver.openInputStream(uri) ?: return@withContext null
            stream.use { input ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(8 * 1024)
                var total = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) return@withContext null
                    out.write(buffer, 0, read)
                }
                Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            }
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    /** A new, empty target for the camera, under the provider [authority]. */
    fun cameraTarget(authority: String = context.packageName + ".files"): Uri {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        return FileProvider.getUriForFile(context, authority, File(dir, "${UUID.randomUUID()}.jpg"))
    }
}
