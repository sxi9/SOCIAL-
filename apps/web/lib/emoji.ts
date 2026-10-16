// Hand-rolled emoji set (no picker library — ARCHITECTURE keeps deps lean).
// QUICK_REACTIONS is the six-wide fast row on a bubble; EMOJI_GRID is the
// full static grid (~40) behind the "+" and the composer emoji button.
// Every entry is well under REACTION_EMOJI_MAX_LEN (16 UTF-16 units).

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;

export const EMOJI_GRID = [
  '👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👏',
  '🙏', '💯', '😍', '🤣', '😅', '😊', '😎', '🤔',
  '🙃', '😴', '🤯', '🥳', '😇', '😭', '😡', '🥲',
  '💀', '👀', '🤝', '👋', '✌️', '🤞', '💪', '🫶',
  '💖', '⭐', '⚡', '🌈', '🍕', '☕', '🏆', '✅',
] as const;
