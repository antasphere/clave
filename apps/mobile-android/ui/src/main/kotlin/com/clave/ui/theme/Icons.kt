package com.clave.ui.theme

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import com.clave.ui.R

/**
 * Every glyph the phone draws: the desktop's Heroicons (24/outline) and the provider marks,
 * generated as vector drawables by scripts/build-icons.mjs. One entry per drawable, so a
 * screen can only name a glyph that exists.
 */
enum class ClaveIcon(val resource: Int) {
    ArrowLeft(R.drawable.ic_arrow_left),
    ArrowPath(R.drawable.ic_arrow_path),
    ArrowRightStartOnRectangle(R.drawable.ic_arrow_right_start_on_rectangle),
    ArrowTurnDownRight(R.drawable.ic_arrow_turn_down_right),
    ArrowUp(R.drawable.ic_arrow_up),
    Bell(R.drawable.ic_bell),
    BookOpen(R.drawable.ic_book_open),
    Camera(R.drawable.ic_camera),
    ChatBubbleLeftRight(R.drawable.ic_chat_bubble_left_right),
    Check(R.drawable.ic_check),
    ChevronDown(R.drawable.ic_chevron_down),
    ChevronRight(R.drawable.ic_chevron_right),
    ClipboardDocument(R.drawable.ic_clipboard_document),
    CommandLine(R.drawable.ic_command_line),
    ComputerDesktop(R.drawable.ic_computer_desktop),
    CpuChip(R.drawable.ic_cpu_chip),
    DevicePhoneMobile(R.drawable.ic_device_phone_mobile),
    Document(R.drawable.ic_document),
    DocumentText(R.drawable.ic_document_text),
    EllipsisHorizontal(R.drawable.ic_ellipsis_horizontal),
    ExclamationTriangle(R.drawable.ic_exclamation_triangle),
    Eye(R.drawable.ic_eye),
    EyeSlash(R.drawable.ic_eye_slash),
    Folder(R.drawable.ic_folder),
    GlobeAlt(R.drawable.ic_globe_alt),
    InboxStack(R.drawable.ic_inbox_stack),
    Link(R.drawable.ic_link),
    LockClosed(R.drawable.ic_lock_closed),
    LogoAntigravity(R.drawable.ic_logo_antigravity),
    LogoClaude(R.drawable.ic_logo_claude),
    LogoCodex(R.drawable.ic_logo_codex),
    LogoPi(R.drawable.ic_logo_pi),
    MagnifyingGlass(R.drawable.ic_magnifying_glass),
    PaintBrush(R.drawable.ic_paint_brush),
    PaperClip(R.drawable.ic_paper_clip),
    PencilSquare(R.drawable.ic_pencil_square),
    Photo(R.drawable.ic_photo),
    Play(R.drawable.ic_play),
    Plus(R.drawable.ic_plus),
    QuestionMarkCircle(R.drawable.ic_question_mark_circle),
    ServerStack(R.drawable.ic_server_stack),
    ShieldCheck(R.drawable.ic_shield_check),
    Signal(R.drawable.ic_signal),
    SignalSlash(R.drawable.ic_signal_slash),
    Stop(R.drawable.ic_stop),
    UserCircle(R.drawable.ic_user_circle),
    Wrench(R.drawable.ic_wrench),
    XMark(R.drawable.ic_x_mark);
}

/** A glyph tinted at draw time, the way the desktop paints `currentColor`. */
@Composable
fun Icon(
    icon: ClaveIcon,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = Clave.colors.theme.textSecondary,
    size: Dp = Metrics.controlIcon,
) {
    Image(
        painter = painterResource(icon.resource),
        contentDescription = contentDescription,
        modifier = modifier.size(size),
        colorFilter = ColorFilter.tint(tint),
    )
}
