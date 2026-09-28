# The social redesign — the Gemini prompt, and what happens next

Written 2026-09-28 (NOTES §56). The owner, after all five social steps (§51–§55)
were live: *"everything we did so far looks messy ... it's all over the place.
make it at least the user will only focus there, like there is a background blur
when clicked ... i want it to look professional like social media ... following
ui ux best practices. for example, the search in profile is at the bottom."*

He asked for a prompt to send to Gemini to generate a picture of the updated
UI, which he will send back. **When he does, the next session builds the app to
match it** — see "When the image comes back" at the bottom.

---

## The prompt (send to Gemini as two separate images)

Two images, because six or more phone screens in one picture come out too small
to read. Send PROMPT A, then PROMPT B. Each is complete on its own.

### PROMPT A — Community: feed, a post, chat

```
Create a high-fidelity mobile app UI design presentation board: four iPhone 15 screens side by side on a plain dark charcoal background, each screen 393 x 852, sharp and readable, like a Dribbble or Behance case study. No hands, no devices at an angle — flat, front-facing screens with thin rounded device outlines.

THE APP: "Nomi", a study app with a social side. Dark mode. Mascot: a small cute brown owl named Nomi (use only as a tiny logo in the top bar of the first screen). Friendly, calm, professional — like Instagram, Threads and Messenger, not childish.

DESIGN SYSTEM (use exactly):
- Background #0e191e, surfaces/cards #16252b, hairline dividers #43575e at low opacity, primary text #e9efee, secondary text #9fb0b3, single accent teal #6cb7c9 (text on accent #08222a), danger #f0b1ad, success #7fcb9f.
- Typography: a clean sans-serif (like Inter or SF Pro). Screen titles 22–28pt semibold, names 15pt semibold, body 15pt regular, meta 12–13pt secondary.
- 8-point spacing grid, 16px side margins, corner radius 12–16px, 44px minimum touch targets.
- Icons: one consistent outlined icon set, 24px, 1.75px stroke (home, search, plus, bell, paper-plane, heart, comment bubble, share, more "...", settings gear, people, globe, lock).
- Bottom tab bar on every screen, 5 tabs with icon + label: Nomi, Notes, Community (selected, teal, with a small teal unread badge "2"), Progress, Profile.

SCREEN 1 — "Community" feed:
- Top app bar: title "Community" left; right side icons: search, paper-plane (messages) with a small teal badge.
- Under it a slim underline tab switcher (not big pill buttons): Feed (selected, teal underline) · Sets · Chat.
- A compact composer row: small circular avatar + rounded field "Share something…" + a photo icon.
- Feed of posts separated by thin dividers (not heavy bordered boxes). Each post: avatar, name in semibold, "@username · 2h" and a small people icon meaning "Friends only"; the text; then a row of outlined action icons with counts: heart 12, comment 3, share; a "..." menu at the top right of each post.
- Post 1: text "Passed my anatomy exam today! 🎉" with a full-width photo of a study desk with notes and coffee, rounded corners.
- Post 2: a shared flashcard set: a card preview showing set title "Cell Biology — 24 cards", a flashcard in the middle reading "What does the mitochondria do?" with "Tap to flip" and small "1 of 12" and "Next ›", and a "Study this set" link.
- Post 3: a streak brag card: a cute potato-shaped pet character, big "30 days" and "30 days in a row — my potato is fully grown."

SCREEN 2 — a single post with comments:
- Top bar: back chevron, title "Post", "..." menu.
- The photo post from screen 1, full width.
- "Comments (3)" heading, then three comments: small avatar, name + time on one line, comment text below, a light "Reply · Like" row.
- A composer pinned to the bottom above the keyboard area: avatar, rounded field "Write a comment…", teal send arrow.

SCREEN 3 — "Chat" (Community with the Chat tab selected):
- Same top bar and underline tabs, Chat selected.
- A rounded search field at the TOP: "Search messages".
- A pinned row "Everyone — the room everyone shares" with a group icon.
- A list of conversations: avatar, name (bold when unread), last message preview and time, a small teal unread count bubble on the right for two of them.
- A floating or top-right "new message" pencil icon.

SCREEN 4 — a conversation, with a sheet open over it:
- Behind: a Messenger-style conversation with "Maria" (avatar + name in the top bar, "..." menu): her bubbles left on the card color, mine right in teal, "Seen" in small text under my last message.
- In front: the conversation is DIMMED AND BLURRED (frosted glass backdrop), and a bottom sheet slides up with a grab handle and rounded top corners: a row of six emoji reactions (❤️ 😂 😮 😢 😡 👍), then list rows with icons: "Reply", "Edit", "Unsend", "Report", in that order, "Report" in the danger color.

Clean alignment, generous whitespace, nothing cramped, consistent paddings across all four screens. Label each screen underneath in small grey text: "Feed", "Post", "Chat", "Conversation".
```

### PROMPT B — Profile, a person, search, progress, posting

```
Create a high-fidelity mobile app UI design presentation board: four iPhone 15 screens side by side on a plain dark charcoal background, each screen 393 x 852, sharp and readable, like a Dribbble or Behance case study. Flat, front-facing screens with thin rounded device outlines.

THE APP: "Nomi", a study app with a social side. Dark mode. Mascot: a small cute brown owl named Nomi. Friendly, calm, professional — like Instagram, Threads and LinkedIn, not childish.

DESIGN SYSTEM (use exactly):
- Background #0e191e, surfaces/cards #16252b, hairline dividers #43575e at low opacity, primary text #e9efee, secondary text #9fb0b3, single accent teal #6cb7c9 (text on accent #08222a), danger #f0b1ad, success #7fcb9f.
- Typography: a clean sans-serif (like Inter or SF Pro). Screen titles 22–28pt semibold, names 15pt semibold, body 15pt, meta 12–13pt secondary.
- 8-point spacing grid, 16px side margins, corner radius 12–16px, 44px minimum touch targets.
- Icons: one consistent outlined icon set, 24px, 1.75px stroke.
- Bottom tab bar on every screen, 5 tabs with icon + label: Nomi, Notes, Community, Progress, Profile.

SCREEN 1 — "Profile" (my own; Profile tab selected):
- Top bar: "@paul_m" on the left; right icons: search, settings gear.
- Header: large circular photo avatar (96px), name "Paul Christian", "@paul_m", a one-line bio.
- A stats row of three evenly spaced numbers with labels: "24 Friends", "12 Posts", "🔥 30 Streak".
- Two buttons side by side: "Edit profile" (outlined) and "Share profile" (outlined).
- A slim banner card: "2 friend requests" with two tiny overlapping avatars and a chevron ›.
- Underline tabs: Posts (selected) · Sets · Friends — then a 3-column grid of post thumbnails (photos, a flashcard-set tile, a streak tile).

SCREEN 2 — search, open over Profile:
- The profile behind is DIMMED AND BLURRED (frosted glass).
- At the top, a focused search field with a cancel button: "maria".
- Results grouped with small section headers: "People" (rows: avatar, name, @username, and a small "Add friend" or "Friends" pill on the right), "Sets" (rows with a stack icon, title and card count), "Posts" (one row with a thumbnail).
- Under the search field before results, a "Recent" row of chips is acceptable.

SCREEN 3 — "Progress" with friends' streaks:
- Title "Progress".
- A hero card: the cute potato-shaped pet character large, "12 days in a row", a thin teal progress bar "18 more days and it grows".
- A card "Friends' streaks": a clean ranked list — rank number, avatar, name, and on the right "🔥 21 days" with "Best 30" small beneath. My own row ("You") highlighted with a teal outline. A small grey line at the bottom: "Your friends see your streak · Change in Settings".
- Below it, the start of a "What you know" card with four clean vertical bars.

SCREEN 4 — writing a new post, as a sheet:
- Behind: the Community feed, DIMMED AND BLURRED.
- A tall bottom sheet with a grab handle: header row "Cancel" (left), "New post" (center), "Post" (right, teal button).
- My avatar and name, with an audience chip under the name: "👥 Friends ▾".
- A large text area "What do you want to share?" with some typed text.
- An attached photo preview with a small "✕" to remove it.
- A toolbar row at the bottom of the sheet with icons: photo, flashcard set, streak flame, emoji.

Clean alignment, generous whitespace, consistent paddings across all four screens. Label each screen underneath in small grey text: "Profile", "Search", "Progress", "New post".
```

---

## What the prompts ask for, and why (UI/UX rules the redesign keeps)

- **Search is at the top** of any list it searches, and opens as a focused
  full-screen layer over a blurred page — never below the content it finds.
- **Everything temporary is a sheet over a blurred, dimmed page**: reactions and
  message actions, report, block, post actions, the composer, the rules. One
  thing at a time, with a grab handle and rounded top corners. The app already
  has the blur (`backdropFilter: 'blur(6px)'` in `Sheet`, src/ui/people.tsx);
  the redesign makes every temporary panel one of these.
- **Top bars carry actions** (search, messages, settings, new post) as icons on
  the right, title on the left; content does not.
- **Underline tabs for switching views inside a screen**, not big pill buttons.
- **Lists are rows with dividers, not a stack of bordered boxes.** Cards only
  where something is a distinct object (a post's set, a streak).
- **One accent colour, one icon style, one spacing scale** everywhere.
- **The primary action per screen is obvious; everything else is quieter.**

## When the image comes back — the plan for the next session

1. Read `docs/HANDOFF.md` (rules, gotchas) and NOTES §51–§56 first.
2. Look at the owner's image(s). Treat them as the target for layout, hierarchy
   and components — keep the app's real data, wording rules ("no technical
   jargon"), accessibility rules (labels, 44pt targets, never colour alone,
   `INPUT_FONT_SIZE`), and dark AND light themes.
3. **Decide the icon question with the owner first.** The app draws its few
   icons as Views (src/ui/glyphs.tsx) and HANDOFF forbids new dependencies
   without a measured reason. The redesign needs ~15 icons. Options: keep
   drawing them as Views (no dependency, more work), or add `react-native-svg` +
   a small icon set (measure the bundle cost first — `npm run export:web`, the
   entry bundle is ~2.5 MB raw today). Put it to him with the numbers.
4. Build in this order, one screen family at a time, photographing each at
   393 px dark with `npm run screenshot -- <route> <file> --width 393 --dark`
   and comparing to the image:
   1. shared pieces: top bar with actions, underline tabs, list rows with
      dividers, one `Sheet` for everything temporary (grab handle, blur);
   2. Community (Feed, Sets, Chat inbox) + the search layer;
   3. a post and its comments; the composer as a sheet;
   4. Profile (header, stats, requests banner, Posts/Sets/Friends tabs) and a
      person's page; search moves to the top (Profile's "Find people" becomes
      the search layer);
   5. conversation + the Everyone room;
   6. Progress's friends' streaks; the Reports screen; the rules sheet.
5. Keep every probe passing: `friends-probe`, `posts-probe`, `messages-probe`,
   `community-probe`, `scroll-probe --height 420`, and the isolation test. Many
   probes find controls by their accessibility labels — keep the labels, or
   update the probe in the same change and say so.
6. Tests that pin layout will need to move with it (screens.test.ts' Settings
   order, community/messages/posts tests' pane names). Move them; never weaken
   what they guard.
