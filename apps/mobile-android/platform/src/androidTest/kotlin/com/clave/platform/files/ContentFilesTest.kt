package com.clave.platform.files

import android.util.Base64
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.core.chat.PickedKind
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ContentFilesTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val authority = context.packageName + ".files"
    private val bytes = "hello world".toByteArray(Charsets.UTF_8)
    private lateinit var file: File

    @Before
    fun write() {
        file = File(context.cacheDir, "notes.txt").apply { writeBytes(bytes) }
        assertEquals(11, bytes.size)
    }

    @After
    fun delete() {
        file.delete()
        File(context.cacheDir, "camera").deleteRecursively()
    }

    @Test
    fun describesAProviderFile() = runBlocking {
        val uri = FileProvider.getUriForFile(context, authority, file)
        val picked = ContentFiles(context).describe(uri)
        assertNotNull(picked)
        assertEquals("notes.txt", picked!!.name)
        assertEquals(11L, picked.size)
        assertEquals("text/plain", picked.mimeType)
        assertEquals(PickedKind.File, picked.kind)
        assertEquals(uri.toString(), picked.uri)
    }

    @Test
    fun theKindHintWins() = runBlocking {
        val uri = FileProvider.getUriForFile(context, authority, file)
        assertEquals(PickedKind.Image, ContentFiles(context).describe(uri, PickedKind.Image)!!.kind)
    }

    @Test
    fun readsUnderTheCeilingOnly() = runBlocking {
        val uri = FileProvider.getUriForFile(context, authority, file)
        val files = ContentFiles(context)
        assertArrayEquals(bytes, Base64.decode(files.readBase64(uri, 1024)!!, Base64.NO_WRAP))
        assertArrayEquals(bytes, Base64.decode(files.readBase64(uri, 11)!!, Base64.NO_WRAP))
        assertNull(files.readBase64(uri, 4))
    }

    @Test
    fun aMissingFileReadsAsNull() = runBlocking {
        val uri = FileProvider.getUriForFile(context, authority, File(context.cacheDir, "absent.txt"))
        assertNull(ContentFiles(context).readBase64(uri, 1024))
    }

    @Test
    fun theCameraTargetIsAProviderJpeg() {
        val uri = ContentFiles(context).cameraTarget()
        assertEquals("content", uri.scheme)
        assertEquals(authority, uri.authority)
        assertTrue(uri.toString().endsWith(".jpg"))
        assertTrue(File(context.cacheDir, "camera").isDirectory)
    }
}
