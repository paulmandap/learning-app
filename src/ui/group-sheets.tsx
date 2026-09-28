import { Body, Button, Notice } from './components';
import { Sheet, SheetTitle } from './sheet';

/**
 * Leaving a group, said before it happens (NOTES §58): what you lose, what
 * stays, and — if you made it — who takes over. From the group's ⋯ and from
 * who is in it.
 */
export function LeaveSheet({
  title,
  owner,
  busy,
  error,
  onLeave,
  onClose,
}: {
  title: string;
  owner: boolean;
  busy: boolean;
  error: Error | null;
  onLeave: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose}>
      <SheetTitle>{`Leave ${title}?`}</SheetTitle>
      <Body muted>You won&apos;t see its messages any more. What you sent stays for the others.</Body>
      {owner ? (
        <Body muted>You made it, so whoever has been in it longest will be able to rename it and remove people.</Body>
      ) : null}
      {error ? <Notice tone="error">{error.message}</Notice> : null}
      <Button label="Leave group" variant="danger" onPress={onLeave} busy={busy} />
      <Button label="Stay" variant="secondary" onPress={onClose} disabled={busy} />
    </Sheet>
  );
}
