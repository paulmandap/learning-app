import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Label, Notice } from './components';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import {
  fetchReminders,
  reminderSupport,
  RemindersUnavailableError,
  saveReminderSlots,
  turnOffReminders,
  turnOnReminders,
} from '../data/reminders';
import { ALL_SLOTS, cleanSlots, nextReminder, REMINDER_TIMES, type ReminderSlot } from '../core/reminders';

/**
 * Settings' Reminders card (NOTES §45).
 *
 * Up to three a day; a person picks which, and turns them on here — the tap an
 * iPhone needs before it will ask about notifications at all. On a phone that
 * cannot get them yet, it says what would change that rather than showing a
 * button that cannot work.
 */
export function RemindersCard() {
  const t = useTheme();
  const client = useQueryClient();
  const [support, setSupport] = useState(reminderSupport);
  const canAsk = support === 'ready' || support === 'blocked';
  const { data: settings, isLoading } = useQuery({
    queryKey: ['reminders'],
    queryFn: fetchReminders,
    enabled: canAsk,
  });
  // The times picked before turning them on. All three unless changed.
  const [chosen, setChosen] = useState<ReminderSlot[]>([...ALL_SLOTS]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  const on = !!settings && settings.thisDevice && settings.slots.length > 0;
  const slots = on ? settings.slots : chosen;

  function failed(err: unknown, doing: string) {
    console.warn(`[reminders] could not ${doing}: ${err instanceof Error ? err.message : String(err)}`);
    setNote(
      err instanceof RemindersUnavailableError
        ? { tone: 'warn', text: "Reminders aren't switched on yet." }
        : { tone: 'error', text: `Couldn't ${doing} just now. Try again in a moment.` },
    );
  }

  function toggle(slot: ReminderSlot) {
    const next = slots.includes(slot) ? slots.filter((s) => s !== slot) : cleanSlots([...slots, slot]);
    setNote(null);
    if (!on) {
      setChosen(next);
      return;
    }
    if (next.length === 0) {
      setNote({ tone: 'warn', text: 'Keep at least one time, or turn reminders off.' });
      return;
    }
    setBusy(true);
    saveReminderSlots(next)
      .then(() => client.invalidateQueries({ queryKey: ['reminders'] }))
      .catch((err: unknown) => failed(err, 'change that'))
      .finally(() => setBusy(false));
  }

  function turnOn() {
    setBusy(true);
    setNote(null);
    // Called straight from the tap: it asks for permission before awaiting anything.
    turnOnReminders(slots)
      .then(async (result) => {
        if (result === 'blocked') {
          setSupport(reminderSupport());
          return;
        }
        await client.invalidateQueries({ queryKey: ['reminders'] });
        const next = nextReminder(slots, Date.now());
        setNote({
          tone: 'ok',
          text: next ? `Reminders are on. The next one is at ${next.label}, unless you've studied by then.` : 'Reminders are on.',
        });
      })
      .catch((err: unknown) => failed(err, 'turn reminders on'))
      .finally(() => setBusy(false));
  }

  function turnOff() {
    setBusy(true);
    setNote(null);
    turnOffReminders()
      .then(() => client.invalidateQueries({ queryKey: ['reminders'] }))
      .then(() => setNote({ tone: 'ok', text: 'Reminders are off.' }))
      .catch((err: unknown) => failed(err, 'turn reminders off'))
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <Body>Reminders</Body>
      <Body muted>Up to three a day, saying what's due — and none once you've studied that day.</Body>

      {support === 'install' ? (
        <Body muted>
          On an iPhone, add Nomi to your Home Screen from the Share menu, then open it from there to turn reminders on.
        </Body>
      ) : support === 'unsupported' ? (
        <Body muted>This browser can't show reminders.</Body>
      ) : support === 'blocked' ? (
        <Notice tone="warn">
          Notifications are off for Nomi. Turn them on in your phone's Settings, under Notifications, then come back here.
        </Notice>
      ) : isLoading ? null : settings === null ? (
        <Notice tone="warn">Reminders aren't switched on yet.</Notice>
      ) : (
        <>
          <Label>When</Label>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
            {REMINDER_TIMES.map((time) => {
              const picked = slots.includes(time.slot);
              return (
                <Pressable
                  key={time.slot}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${time.label} reminder`}
                  accessibilityState={{ checked: picked, disabled: busy }}
                  disabled={busy}
                  onPress={() => toggle(time.slot)}
                  style={{
                    minHeight: TOUCH_TARGET,
                    minWidth: 76,
                    paddingHorizontal: space.lg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.pill,
                    // A heavier accent ring when picked, so the choice never
                    // rests on colour alone — as the face picker does it.
                    borderWidth: picked ? 2 : 1,
                    borderColor: picked ? t.accent : t.border,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  <Text style={[type.label, { color: picked ? t.text : t.textMuted }]}>{time.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {on ? (
            <Button label="Turn off reminders" variant="secondary" onPress={turnOff} busy={busy} />
          ) : (
            <Button label="Turn on reminders" variant="outline" onPress={turnOn} busy={busy} disabled={slots.length === 0} />
          )}
        </>
      )}

      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
    </Card>
  );
}
