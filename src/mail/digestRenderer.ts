import type { KnownBlock } from '@slack/types';
import type { MailDigest, MailDigestItem } from './types.js';
import type { MailStore } from './threadStore.js';

/**
 * Pure rendering of a MailDigest (Claude's JSON output) into Slack Block Kit
 * blocks, reconciled against the authoritative SQLite ProposedAction rows.
 *
 * Claude's JSON output is not trusted for anything actionable: a digest item
 * only gets Approve/Reject buttons when its proposedActionId resolves to a
 * real, still-`pending` row in MailStore. Anything missing or already
 * decided/executed is rendered as inert text so a stale or hallucinated
 * digest can never produce a live action button.
 *
 * Known v1 limitation: Slack messages cap out around 50 blocks. Each digest
 * item renders 2 blocks (section + optional actions) plus dividers, so a
 * very large digest.items list could exceed that limit. Pagination across
 * multiple messages is out of scope for v1 — callers should keep digests
 * reasonably small (e.g. via the triage prompt) until that's addressed.
 */
export function renderDigestBlocks(digest: MailDigest, store: MailStore): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: digest.summary },
  });

  blocks.push({ type: 'divider' });

  digest.items.forEach((item: MailDigestItem, idx: number) => {
    const action = store.getProposedAction(item.proposedActionId);

    let statusNote = '';
    let renderButtons = false;

    if (!action) {
      statusNote = '\n_(action not found — this proposal may be stale)_';
    } else if (action.status !== 'pending') {
      statusNote = `\n_(already ${action.status} — no action needed)_`;
    } else {
      renderButtons = true;
    }

    const itemText =
      `*${item.subject}*\n` +
      `From: ${item.from}\n` +
      `${item.analysis}` +
      statusNote;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: itemText },
    });

    if (renderButtons) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            action_id: 'mail_approve',
            value: item.proposedActionId,
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject' },
            action_id: 'mail_reject',
            value: item.proposedActionId,
            style: 'danger',
          },
        ],
      });
    }

    if (idx < digest.items.length - 1) {
      blocks.push({ type: 'divider' });
    }
  });

  return blocks;
}
