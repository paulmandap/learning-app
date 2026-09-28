import { Pressable, Text, View } from 'react-native';
import { Rows } from './components';
import { PersonAvatar } from './avatar';
import { Icon } from './glyphs';
import { space, TOUCH_TARGET, type, useTheme } from './theme';
import { atUsername, personName, type FriendLink } from '../core/social';

/**
 * Friends to choose several of — making a group, and adding people to one
 * (NOTES §58). A tick in a round box on the chosen ones, as well as the row
 * being announced as checked: never colour alone.
 *
 * `disabled` rows are there but cannot be chosen — somebody already in the
 * group, or a group already full — and say why in their second line, rather
 * than vanishing from a list somebody expects them in.
 */
export function FriendPicker({
  friends,
  chosen,
  onToggle,
  disabled = {},
}: {
  friends: readonly FriendLink[];
  chosen: ReadonlySet<string>;
  onToggle: (personId: string) => void;
  /** person id → why they cannot be picked. */
  disabled?: Readonly<Record<string, string>>;
}) {
  const t = useTheme();
  return (
    <Rows card>
      {friends.map((f) => {
        const name = personName(f);
        const handle = atUsername(f.username);
        const why = disabled[f.person_id];
        const on = chosen.has(f.person_id);
        return (
          <Pressable
            key={f.person_id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: !!why }}
            aria-checked={on}
            accessibilityLabel={why ? `${name}. ${why}` : name}
            onPress={() => onToggle(f.person_id)}
            disabled={!!why}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              minHeight: TOUCH_TARGET + space.sm,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              backgroundColor: pressed ? t.bg : 'transparent',
              opacity: why ? 0.55 : 1,
            })}
          >
            <PersonAvatar avatar={f.avatar} userId={f.person_id} name={name} size={36} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
                {name}
              </Text>
              {why || (handle && handle !== name) ? (
                <Text style={[type.caption, { color: t.textMuted }]} numberOfLines={1}>
                  {why ?? handle}
                </Text>
              ) : null}
            </View>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: on ? t.accent : t.border,
                backgroundColor: on ? t.accent : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {on ? <Icon name="check" color={t.accentText} size={16} /> : null}
            </View>
          </Pressable>
        );
      })}
    </Rows>
  );
}
