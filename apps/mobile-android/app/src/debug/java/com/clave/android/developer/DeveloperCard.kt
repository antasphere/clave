package com.clave.android.developer

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import com.clave.ui.components.ListRow
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.Icon

/** The Machines screen's development section: one row that opens the developer screen. */
@Composable
fun DeveloperCard(onOpen: () -> Unit) {
    Column {
        SectionLabel("Development")
        ListRow(
            title = "Developer connection",
            subtitle = "A standalone server on this network, by address and token.",
            leading = { Icon(ClaveIcon.CommandLine, contentDescription = null, tint = Clave.colors.theme.textTertiary) },
            onClick = onOpen,
        )
    }
}
