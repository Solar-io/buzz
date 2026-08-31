/**
 * `:code:` emoji autocomplete for the composer — the desktop's
 * EmojiAutocomplete trimmed to a common-emoji table. Typing ":smil" pops
 * suggestions; accepting one replaces the token with the emoji character.
 */

export const EMOJI_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  [":smile:", "😄"],
  [":smiley:", "😃"],
  [":grin:", "😁"],
  [":laughing:", "😆"],
  [":joy:", "😂"],
  [":rofl:", "🤣"],
  [":wink:", "😉"],
  [":blush:", "😊"],
  [":heart_eyes:", "😍"],
  [":kissing_heart:", "😘"],
  [":thinking:", "🤔"],
  [":neutral_face:", "😐"],
  [":expressionless:", "😑"],
  [":eye_roll:", "🙄"],
  [":smirk:", "😏"],
  [":persevere:", "😣"],
  [":disappointed:", "😞"],
  [":worried:", "😟"],
  [":cry:", "😢"],
  [":sob:", "😭"],
  [":scream:", "😱"],
  [":flushed:", "😳"],
  [":star_struck:", "🤩"],
  [":zany:", "🤪"],
  [":shrug:", "🤷"],
  [":facepalm:", "🤦"],
  [":pleading:", "🥺"],
  [":party:", "🥳"],
  [":sleeping:", "😴"],
  [":ghost:", "👻"],
  [":skull:", "💀"],
  [":robot:", "🤖"],
  [":alien:", "👽"],
  [":clown:", "🤡"],
  [":thumbsup:", "👍"],
  [":thumbsdown:", "👎"],
  [":ok_hand:", "👌"],
  [":wave:", "👋"],
  [":clap:", "👏"],
  [":pray:", "🙏"],
  [":muscle:", "💪"],
  [":point_up:", "☝️"],
  [":eyes:", "👀"],
  [":heart:", "❤️"],
  [":broken_heart:", "💔"],
  [":sparkling_heart:", "💖"],
  [":fire:", "🔥"],
  [":star:", "⭐"],
  [":sparkles:", "✨"],
  [":boom:", "💥"],
  [":zap:", "⚡"],
  [":rocket:", "🚀"],
  [":airplane:", "✈️"],
  [":warning:", "⚠️"],
  [":check:", "✅"],
  [":cross:", "❌"],
  [":question:", "❓"],
  [":exclamation:", "❗"],
  [":bulb:", "💡"],
  [":coffee:", "☕"],
  [":pizza:", "🍕"],
  [":beer:", "🍺"],
  [":cake:", "🎂"],
  [":tada:", "🎉"],
  [":confetti:", "🎊"],
  [":balloon:", "🎈"],
  [":gift:", "🎁"],
  [":trophy:", "🏆"],
  [":medal:", "🏅"],
  [":target:", "🎯"],
  [":dart:", "🎯"],
  [":chart:", "📈"],
  [":money:", "💰"],
  [":dollar:", "💵"],
  [":bug:", "🐛"],
  [":wrench:", "🔧"],
  [":hammer:", "🔨"],
  [":gear:", "⚙️"],
  [":lock:", "🔒"],
  [":key:", "🔑"],
  [":mag:", "🔍"],
  [":link:", "🔗"],
  [":paperclip:", "📎"],
  [":memo:", "📝"],
  [":pencil:", "✏️"],
  [":book:", "📖"],
  [":computer:", "💻"],
  [":phone:", "📱"],
  [":octopus:", "🐙"],
  [":rainbow:", "🌈"],
  [":sun:", "☀️"],
  [":moon:", "🌙"],
  [":umbrella:", "☂️"],
  [":snowflake:", "❄️"],
];

const LOOKUP = new Map(EMOJI_ENTRIES);

/**
 * The in-progress `:code` token at the caret (no closing colon yet), or null
 * when the caret is not inside one.
 */
export function activeEmojiQuery(text: string, caret: number): string | null {
  const upToCaret = text.slice(0, caret);
  const open = upToCaret.lastIndexOf(":");
  if (open === -1) {
    return null;
  }
  const token = upToCaret.slice(open + 1);
  // Reject closed tokens (:smile:) and tokens with spaces/other colons.
  if (token.length === 0 || /[\s:]/.test(token)) {
    return null;
  }
  return token;
}

/** Prefix matches on the code, capped for the popup. */
export function emojiSuggestions(
  token: string,
  limit = 6,
): { code: string; emoji: string }[] {
  const lower = token.toLowerCase();
  return EMOJI_ENTRIES.filter(([code]) => code.includes(`:${lower}`))
    .slice(0, limit)
    .map(([code, emoji]) => ({ code, emoji }));
}

/** Replace the open token at the caret with the emoji (or its full code). */
export function applyEmojiCompletion(
  text: string,
  caret: number,
  emoji: string,
): { text: string; caret: number } {
  const upToCaret = text.slice(0, caret);
  const open = upToCaret.lastIndexOf(":");
  if (open === -1) {
    return { text, caret };
  }
  const next = `${text.slice(0, open)}${emoji}${text.slice(caret)}`;
  return { text: next, caret: open + emoji.length };
}

export function emojiForCode(code: string): string | undefined {
  return LOOKUP.get(code);
}
