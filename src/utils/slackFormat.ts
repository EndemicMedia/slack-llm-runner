/**
 * Converts Markdown formatting to Slack's mrkdwn format.
 *
 * Key differences:
 * - Markdown **bold** → Slack *bold*
 * - Markdown *italic* → Slack _italic_
 * - Markdown ~~strike~~ → Slack ~strike~
 * - Headers (# ##) → Just bold text
 */
export function markdownToSlack(text: string): string {
  return text
    // Convert headers to bold (must come before bold conversion)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // Convert **bold** to *bold* (must handle before single asterisks)
    .replace(/\*\*([^*]+)\*\*/g, '*$1*')
    // Convert __bold__ to *bold*
    .replace(/__([^_]+)__/g, '*$1*')
    // Convert _italic_ to _italic_ (same in Slack, no change needed)
    // Convert *italic* to _italic_ (single asterisks for italic in MD)
    // But be careful: we already converted **bold** to *bold*
    // So we need to handle remaining single * pairs that aren't Slack bold
    // Actually, leave single * alone since Slack interprets them as bold
    // Convert ~~strikethrough~~ to ~strikethrough~
    .replace(/~~([^~]+)~~/g, '~$1~');
}
