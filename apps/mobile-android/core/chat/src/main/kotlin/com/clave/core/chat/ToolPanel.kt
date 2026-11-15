/**
 * What one opened call shows, the desktop's `ToolPanel` (ToolGroup.tsx): its command as
 * shell code, then each section with the language it reads as, and the call's few words
 * ("Exit 1", "Lines 1–40"). The row's own line is [toolLine]: the verb, then the target.
 */
package com.clave.core.chat

data class PanelSection(val label: String, val text: String, val language: String?)

data class ToolPanelView(val label: String, val detail: String?, val sections: List<PanelSection>)

fun toolPanel(tool: Entry.Tool): ToolPanelView {
    val description = describeTool(tool)
    val kind = description.kind
    val target = description.target
    val sections = mutableListOf<PanelSection>()
    if (kind == ToolKind.Command && target.isNotEmpty()) sections.add(PanelSection("Command", target, "bash"))
    description.sections
        .filter { kind != ToolKind.Command || it.label != "Command" }
        .forEach { sections.add(PanelSection(it.label, it.text, sectionLanguage(kind, it, target))) }
    return ToolPanelView(description.label, description.detail, sections)
}

/** A call's row as the desktop's `ToolLine` reads it: "Ran npm test", "Read src/a.kt". */
fun toolLine(tool: Entry.Tool): String {
    val head = describeToolHead(tool)
    val verb = toolVerb(head.kind, head.label)
    val target = head.target.lineSequence().firstOrNull().orEmpty()
    return if (target.isEmpty()) verb else "$verb $target"
}
