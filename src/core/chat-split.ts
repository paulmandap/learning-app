/**
 * Chats side by side (NOTES §74, the owner's choice): on a window wide enough,
 * the chat list stays on the left while a chat is open, as Messenger does on a
 * computer, and choosing another chat swaps the right side.
 *
 * Wide enough is the list beside a chat at the width chats are drawn at
 * anyway, CONTENT_MAX_WIDTH (tests/pc-version.test.ts holds the sum). A phone,
 * and a narrow window, keep one thing on screen at a time, as before.
 */
export const CHAT_LIST_WIDTH = 340;
export const CHAT_SPLIT_MIN_WIDTH = 900;

export function showChatList(windowWidth: number): boolean {
  return windowWidth >= CHAT_SPLIT_MIN_WIDTH;
}
