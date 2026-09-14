import { Linking, Pressable, Text, View } from 'react-native';
import { Screen, Title } from './components';
import { space, TOUCH_TARGET, type, useTheme } from './theme';
import { CONTACT_EMAIL, type LegalDocument } from '../core/legal';

/**
 * A legal document you can actually read: its date, numbered headings, short
 * paragraphs and lists drawn as lists (NOTES §40). The words are in
 * `src/core/legal.ts`; this only lays them out.
 *
 * Reachable signed out as well as in — from the sign-in screen, before anyone
 * agrees to anything — so it uses nothing that needs an account.
 */
export function LegalScreen({
  doc,
  related,
}: {
  doc: LegalDocument;
  /** The other document, linked at the foot. */
  related: { label: string; onPress: () => void };
}) {
  const t = useTheme();
  const paragraph = [type.body, { color: t.text }];

  return (
    <Screen>
      <View style={{ gap: space.xs }}>
        <Title>{doc.title}</Title>
        <Text style={[type.caption, { color: t.textMuted }]}>Effective {doc.effective}</Text>
      </View>
      <Text style={paragraph}>{doc.intro}</Text>

      {doc.sections.map((section, i) => (
        <View key={section.heading} style={{ gap: space.sm }}>
          <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>
            {i + 1}. {section.heading}
          </Text>
          {section.body.map((part, j) =>
            typeof part === 'string' ? (
              <Text key={j} style={paragraph}>
                {part}
              </Text>
            ) : (
              <View key={j} style={{ gap: space.xs }}>
                {part.map((item) => (
                  <View key={item} style={{ flexDirection: 'row', gap: space.sm }}>
                    <Text style={[type.body, { color: t.textMuted }]}>•</Text>
                    <Text style={[type.body, { color: t.text, flex: 1 }]}>{item}</Text>
                  </View>
                ))}
              </View>
            ),
          )}
        </View>
      ))}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg }}>
        <TextLink label={`Email ${CONTACT_EMAIL}`} onPress={() => void Linking.openURL(`mailto:${CONTACT_EMAIL}`)} />
        <TextLink label={related.label} onPress={related.onPress} />
      </View>
    </Screen>
  );
}

/** A link in running text, still a full touch target. */
export function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: TOUCH_TARGET, justifyContent: 'center' }}
    >
      <Text style={[type.label, { color: t.accent }]}>{label}</Text>
    </Pressable>
  );
}
