# File Browser

Browse, search, preview, and edit files in your project without switching apps.

[Open File Browser](clave://navigate/side:files)

## File Tree

The right sidebar's **Files** tab shows a directory tree for the current session's working directory. Expand and collapse folders, right-click for context actions (open externally, reveal in Finder, copy path).

## Quick Search (Cmd+P)

Press **Cmd+P** to open the file palette, a fuzzy search across all files in the current directory. Type to filter, use arrow keys to navigate, and press Enter to open.

## File Preview

Double-click any file in the tree to preview it (a single click selects it, and right-click offers Open in Tab and Edit):

- **Markdown**: Rendered with full formatting
- **Code files**: Syntax-highlighted with line numbers
- **Images**: Rendered inline (PNG, JPG, GIF, SVG, WebP, BMP, ICO)
- **PDFs and HTML**: Button to open in an external viewer

File metadata (size, line count) is shown at the top.

## Inline Editing

Text files can be edited directly in the preview panel. Make changes and save without opening a separate editor.

## Remote File Browsing

For remote sessions (SSH), the file tree works over SFTP. You can browse, preview, and read files on the remote machine.

## Opening the Sidebar

- **Cmd+E**: Toggle the right sidebar
- The sidebar remembers which tab (Files or Git) you had open; Help opens with **Cmd+?**
