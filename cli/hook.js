// What pearbell inbox --hook prints for a Claude Code hook: what the user
// wrote to the session's topic on the phone, handed to Claude, so it can
// answer without the session being a channel (see mcp.js).

export function inboxPrompt (topic, messages) {
  const quoted = messages
    .map((m) => `${m.text.split('\n').map((line) => `> ${line}`).join('\n')}\n(from ${m.device})`)
    .join('\n\n')
  return `The user wrote to you from their phone, on the pearbell topic "${topic}":\n\n${quoted}\n\n` +
    `Answer them with pearbell: the send tool of the pearbell MCP server, or \`pearbell send -T "${topic}" -t "Claude Code" "..."\`, ` +
    'with a short Markdown update on what is done, what you are doing now and what comes next, or whatever else they asked. Then carry on with your task.'
}

// Stop keeps Claude going so it can answer (it stops again after that, since
// the inbox is empty by then). Other events add the text as context.
export function hookOutput (event, text) {
  if (event === 'Stop' || event === 'SubagentStop') return { decision: 'block', reason: text }
  return { hookSpecificOutput: { hookEventName: event || 'PostToolUse', additionalContext: text } }
}
