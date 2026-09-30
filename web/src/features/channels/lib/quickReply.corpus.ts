/**
 * The quick-reply detector's fixture corpus — its contract.
 *
 * POSITIVES are messages that explicitly offer yes and no. NEGATIVES are
 * everything that must never grow Yes / No buttons: questions that do not
 * offer the choices, sentences that only mention them, quoted or fenced text,
 * and asks with more than two options. The negatives are the point — they are
 * real shapes from agent traffic, and each one is a button that would have
 * answered for Sam.
 *
 * `quickReply.test.mjs` asserts the COUNT of each list as well as every case,
 * so a list that silently emptied cannot report success.
 */

export const QUICK_REPLY_POSITIVES: readonly string[] = [
  "Reply yes or no.",
  "Header settle is in. Trim the sent-message hold to 1.5s? Reply yes or no.",
  "Try Sol max on 1–2 more big one-shot builds before 10/8, to see whether the game win repeats?\n\nReply yes or no.",
  "Should I merge fix(web): clamp jitter calibration, yes or no?",
  "Delete the 14 zombie repos? (yes/no)",
  "Proceed with the prune step (y/n)?",
  "Want me to open a PR for this? Yes or no?",
  "Ship it? Yes/No",
  "Tests are green on all three suites.\nPlease reply with yes or no.",
  "Answer yes or no: is the staging relay safe to restart now?",
  "**Restart the relay now?** Reply **yes or no**.",
  "I can re-run the bake-off tonight. Reply 'yes' or 'no'.",
  "Two options were dropped as unsafe, so this is binary — reply yes or no.",
  "Yes or no?",
];

export const QUICK_REPLY_NEGATIVES: readonly string[] = [
  // Yes/no-shaped, but the choices are never offered: never guess.
  "Should I deploy now?",
  "Is the build green?",
  "Do you want the long version?",
  "Can I delete the old worktrees?",
  "Header settle is in. For beat 03, trim the hold to 1.5s, or keep 2s?",
  // Mentions yes-or-no without asking the reader for one.
  "The health endpoint returns yes or no.",
  "Is this a yes or no question?",
  "Do you know if the API returns yes or no?",
  "I'd say yes or no depending on the load test.",
  "He didn't answer yes or no, so I escalated.",
  "Yes or no, either way the migration runs tonight.",
  "Set confirm to y/n in the config.",
  // More than two choices is not a yes/no question.
  "Reply yes, no, or later.",
  "Reply yes or no or maybe.",
  "Ship it? (yes/no/later)",
  // The ask is not the author's last line.
  "Reply yes or no.\n\nThanks — no rush on this one.",
  "Reply yes or no.\n\nFull log: https://relay.example/run/41",
  // Somebody else's words: quoted or fenced.
  "> Reply yes or no.",
  "The prompt template is:\n```\nReply yes or no.\n```",
  "The template ends with `Reply yes or no.`",
  "Earlier you asked:\n> Ship it? (yes/no)\n\nThat shipped at 14:02.",
  // Statements, reports, and the empty message.
  "Done. 212 passed, 0 failed.",
  "Yes.",
  "No — the relay was still draining.",
  "",
  "   ",
  "```\nyes or no?\n```",
];
