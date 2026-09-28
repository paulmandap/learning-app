import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Notice, Rows } from './components';
import { Sheet, SheetTitle } from './sheet';
import { Icon, type IconName } from './glyphs';
import { TextLink } from './legal';
import { radius, space, type, useTheme } from './theme';
import { COMMUNITY_RULES, RULES_CONSEQUENCES, ruleTitle } from '../core/rules';
import {
  acceptCommunityRules,
  acknowledgeWarning,
  myStanding,
  useRulesPrompt,
} from '../data/moderation';
import { useSessionStore } from '../data/session';

/**
 * Each rule's picture, beside it (NOTES §60). Every key in `COMMUNITY_RULES`
 * has one — tests/redesign.test.ts holds the two together.
 */
export const RULE_ICONS: Record<string, IconName> = {
  kind: 'heart',
  clean: 'hide',
  private: 'lock',
  yourself: 'person',
  spam: 'block',
  yours: 'set',
  honest: 'report',
};

/**
 * The community rules on screen (NOTES §55).
 *
 * One line of title and one of detail each — seven things a person can hold in
 * their head, not a terms page. The Terms of Use still carry the whole
 * agreement; these are the part that is about how to treat each other.
 *
 * Rows with an icon on a tile since §60, the way a set is listed: the numbers
 * they had were an order the rules do not have.
 */
export function RulesList() {
  const t = useTheme();
  return (
    <Rows>
      {COMMUNITY_RULES.map((rule) => (
        <View key={rule.key} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingVertical: space.md }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: t.card,
            }}
          >
            <Icon name={RULE_ICONS[rule.key] ?? 'check'} color={t.accent} size={20} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.bodyStrong, { color: t.text }]}>{rule.title}</Text>
            <Text style={[type.body, { color: t.textMuted }]}>{rule.detail}</Text>
          </View>
        </View>
      ))}
    </Rows>
  );
}

/**
 * "Agree to the community rules" — once, before a first social act.
 *
 * Opened from anywhere: the data layer opens it when the database refuses an
 * act with 'RULES' (`throwIfGated`), so there is one sheet for posting,
 * messaging, adding a friend and sharing a set, mounted once in the root layout.
 * After agreeing, it says to try again rather than retrying for them — the act
 * was refused, and redoing it unseen would be a surprise.
 */
export function RulesSheet() {
  const open = useRulesPrompt((s) => s.open);
  const hide = useRulesPrompt((s) => s.hide);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const close = () => {
    hide();
    setDone(false);
    setError(null);
  };

  async function agree() {
    setBusy(true);
    setError(null);
    try {
      await acceptCommunityRules();
      await queryClient.invalidateQueries({ queryKey: ['standing'] });
      setDone(true);
    } catch {
      setError("Couldn't save that just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Sheet onClose={close}>
        <SheetTitle>Thanks</SheetTitle>
        <Body>You&apos;re all set. Now try that again.</Body>
        <Button label="Done" onPress={close} />
      </Sheet>
    );
  }

  // "I agree" stays at the bottom whatever is scrolled (NOTES §60): seven
  // rules had pushed it below the fold on a phone.
  return (
    <Sheet
      onClose={close}
      footer={
        <>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button label="I agree" onPress={agree} busy={busy} />
          <Button label="Not now" variant="secondary" onPress={close} disabled={busy} />
        </>
      }
    >
      <SheetTitle>Community rules</SheetTitle>
      <Body muted>Before you post, message or add friends, please agree to these.</Body>
      <RulesList />
      <Body muted>{RULES_CONSEQUENCES}</Body>
    </Sheet>
  );
}

/**
 * A warning from the moderator, shown the next time the app opens (NOTES §55,
 * the owner's choice), naming the rule and carrying his note. Acknowledged with
 * one tap and not shown again.
 *
 * Mounted once in the root layout, signed in only.
 */
export function StandingNotice() {
  const t = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const signedIn = useSessionStore((s) => !!s.session);
  const { data } = useQuery({
    queryKey: ['standing'],
    queryFn: () => myStanding(),
    enabled: signedIn,
    refetchOnWindowFocus: true,
    staleTime: 5 * 60 * 1000,
  });
  const [busy, setBusy] = useState(false);

  const warnings = data?.warnings ?? [];
  if (!signedIn || warnings.length === 0) return null;

  async function understood() {
    setBusy(true);
    try {
      for (const w of warnings) await acknowledgeWarning(w.id);
      await queryClient.invalidateQueries({ queryKey: ['standing'] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={() => void understood()}>
      <SheetTitle>A note about the rules</SheetTitle>
      <Body>
        Something you shared on Nomi broke {warnings.length === 1 ? 'a community rule' : 'the community rules'}:
      </Body>
      {warnings.map((w) => (
        <View key={w.id} style={{ gap: 2 }}>
          <Text style={[type.bodyStrong, { color: t.text }]}>{ruleTitle(w.rule)}</Text>
          {w.note ? <Text style={[type.body, { color: t.textMuted }]}>{w.note}</Text> : null}
        </View>
      ))}
      <Body muted>If it happens again, your account can be stopped from posting, messaging and adding friends.</Body>
      <TextLink
        label="Read the community rules"
        onPress={() => {
          void understood();
          router.push('/rules');
        }}
      />
      <Button label="I understand" onPress={() => void understood()} busy={busy} />
    </Sheet>
  );
}
