# Remote Sessions

Connect to remote machines via SSH and run Claude Code or terminal sessions there.

## Adding a Location

1. Open [Settings](clave://navigate/settings) and go to Locations
2. Click **Add Location**
3. Enter SSH connection details (host, user, key or password)

## Session Types

Remote locations support two session types:

- **Remote Terminal**: A plain shell session over SSH
- **Remote Claude**: A Claude Code session running on the remote machine

## Agents

Remote locations can expose agents. Agents appear in the sidebar with their status (online, busy, or offline) and can be started as chat sessions directly from Clave.

## Remote File Browsing

The file tree in the right sidebar works with remote sessions over SFTP. Browse, preview, and read files on the remote machine without a separate client.
