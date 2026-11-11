import type { HelperConfig } from './registry'

/**
 * The CLI arguments of a helper call: one turn on the helper's model with
 * the helper's own system prompt, no MCP server, no skill, no tool. The
 * person's settings stay in force (an `apiKeyHelper` may live there, and
 * `--bare` drops the OAuth and keychain logins), so the reply may still carry
 * their output style: every parser reads past it. `--tools` is variadic and
 * takes the rest of the line, so it comes last and the prompt goes on stdin.
 */
export function helperCliArgs(
  systemPrompt: string,
  config: Pick<HelperConfig, 'model' | 'fallbackModel'>
): string[] {
  const fallback =
    config.fallbackModel && config.fallbackModel !== config.model
      ? ['--fallback-model', config.fallbackModel]
      : []
  return [
    '-p',
    '--model',
    config.model,
    ...fallback,
    '--system-prompt',
    systemPrompt,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--tools',
    ''
  ]
}
