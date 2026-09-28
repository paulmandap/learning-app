import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Notice } from './components';
import { Sheet, SheetTitle } from './people';
import { TextLink } from './legal';
import { space, type, useTheme } from './theme';
import { COMMUNITY_RULES, RULES_CONSEQUENCES, ruleTitle } from '../core/rules';
import {
  acceptCommunityRules,
  acknowledgeWarning,
  myStanding,
  useRulesPrompt,
} from '../data/moderation';
import { useSessionStore } from '../data/session';

/**
 * The community rules on screen (NOTES §55).
 *
 * Numbered, one line of title and one of detail each — seven things a person
 * can hold in their head, not a terms page. The Terms of Use still carry the
 * whole agreement; these are the part that is about how to treat each other.
 */
export function RulesList() {
  const t = useTheme();
  return (
    <View style={{ gap: space.md }}>
      {COMMUNITY_RULES.map((rule, i) => (
        <View key={rule.key} style={{ flexDirection: 'row', gap: space.md }}>
          <Text style={[type.bodyStrong, { color: t.accent, minWidth: 18 }]}>{i + 1}</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[type.bodyStrong, { color: t.text }]}>{rule.title}</Text>
            <Text style={[type.body, { color: t.textMuted }]}>{rule.detail}</Text>
          </View>
        </View>
      ))}
    </View>
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

  return (
    <Sheet onClose={close}>
      {done ? (
        <>
          <SheetTitle>Thanks</SheetTitle>
          <Body>You&apos;re all set. Now try that again.</Body>
          <Button label="Done" onPress={close} />
        </>
      ) : (
        <>
          <SheetTitle>Community rules</SheetTitle>
          <Body muted>Before you post, message or add friends, please agree to these.</Body>
          <RulesList />
          <Body muted>{RULES_CONSEQUENCES}</Body>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <Button label="I agree" onPress={agree} busy={busy} />
          <Button label="Not now" variant="secondary" onPress={close} disabled={busy} />
        </>
      )}
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
