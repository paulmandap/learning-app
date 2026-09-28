import { Text, View } from 'react-native';
import { Body, Label, Screen, Title } from '../src/ui/components';
import { Icon, type IconName } from '../src/ui/glyphs';
import { ICON_SHAPES } from '../src/core/icon-shapes';
import { space, type as typeScale, useTheme } from '../src/ui/theme';

/**
 * Every icon, for photographing while the redesign is built (NOTES §56.2).
 * Not linked from anywhere. Remove it when the redesign is done.
 */
const NAMES = Object.keys(ICON_SHAPES) as IconName[];

export default function Icons() {
  const t = useTheme();
  return (
    <Screen>
      <Title>Icons</Title>
      <Body muted>Drawn with Views, 24 pt.</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: space.lg }}>
        {NAMES.map((name) => (
          <View key={name} style={{ width: '20%', alignItems: 'center', gap: space.xs }}>
            <Icon name={name} color={t.text} />
            <Text style={[typeScale.caption, { color: t.textMuted, fontSize: 10 }]} numberOfLines={1}>
              {name}
            </Text>
          </View>
        ))}
      </View>
      <Label>Filled, and in colour</Label>
      <View style={{ flexDirection: 'row', gap: space.lg, alignItems: 'center' }}>
        <Icon name="heart" color={t.danger} filled />
        <Icon name="bookmark" color={t.accent} filled />
        <Icon name="star" color={t.accent} filled />
        <Icon name="heart" color={t.accent} />
        <Icon name="send" color={t.accent} />
        <Icon name="nomi" color={t.accent} />
      </View>
      <Label>Sizes: 16, 20, 24, 32, 48</Label>
      {(['settings', 'heart', 'nomi'] as IconName[]).map((name) => (
        <View key={name} style={{ flexDirection: 'row', gap: space.lg, alignItems: 'center' }}>
          {[16, 20, 24, 32, 48].map((size) => (
            <Icon key={size} name={name} color={t.text} size={size} />
          ))}
        </View>
      ))}
      <Label>A post's actions</Label>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
        {(
          [
            ['heart', '12'],
            ['comment', '3'],
            ['share', ''],
          ] as [IconName, string][]
        ).map(([name, count]) => (
          <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: space.tight }}>
            <Icon name={name} color={t.textMuted} size={22} />
            {count ? <Text style={[typeScale.label, { color: t.textMuted }]}>{count}</Text> : null}
          </View>
        ))}
        <View style={{ flex: 1 }} />
        <Icon name="bookmark" color={t.textMuted} size={22} />
      </View>
    </Screen>
  );
}
