import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Field, ListRow, Notice } from './components';
import { CONTENT_MAX_WIDTH, elevation, radius, space, type, useTheme } from './theme';
import { GLYPH } from './glyphs';
import {
  canHoldFolders,
  childrenOf,
  folderMeta,
  folderOrder,
  MAX_FOLDER_NAME,
  setsInFolder,
  type Folder,
} from '../core/folders';
import { createFolder, deleteFolder, renameFolder } from '../data/folders';
import { formatSetTitle } from '../core/title';
import type { StudySet } from '../data/sets';

/**
 * One folder, on its own, with everything else out of the way (NOTES §48).
 *
 * The owner: *"maybe when i click the folder, instead of drop down, it will be
 * focused there like some sort of pop out if you know what i mean, then the
 * background is blurred so my focus is only at that folder. once that happens,
 * the add subfolder will work."*
 *
 * ## Why a sheet replaced the drop-down
 *
 * The drop-down put a folder's sets inline under its row, which reads as the
 * same list with extra indentation — and it left nowhere sensible to put
 * anything ABOUT the folder. Renaming it, deleting it, adding a subfolder and
 * moving things in and out are all operations on the folder, and a folder with
 * no surface of its own has no place to offer them. Here the folder IS the
 * screen for as long as it is open.
 *
 * ## The blur
 *
 * `backdrop-filter` is a web CSS property with no react-native equivalent, so
 * it is applied on web only and the dark scrim underneath does the work
 * everywhere else. That ordering matters: the scrim is the effect, and the blur
 * is the refinement on top of it. A sheet that depended on the blur would look
 * unfinished on any platform that did not have it.
 */
export function FolderSheet({
  folder,
  folders,
  sets,
  statsBySet,
  onClose,
  onOpenSet,
  onOpenFolder,
}: {
  folder: Folder;
  /** Every folder, so this one can find its children. */
  folders: Folder[];
  /** Every set, so this one can find the ones directly in it. */
  sets: StudySet[];
  statsBySet: Map<string, { due: number; known: number }>;
  onClose: () => void;
  onOpenSet: (id: string) => void;
  /** Open a subfolder in its own sheet — one level, so it never nests further. */
  onOpenFolder: (folder: Folder) => void;
}) {
  const t = useTheme();
  const queryClient = useQueryClient();

  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const children = folderOrder(childrenOf(folders, folder.id));
  const inside = setsInFolder(sets, folder.id);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['folders'] });
    await queryClient.invalidateQueries({ queryKey: ['sets'] });
  };

  const addSubfolder = useMutation({
    mutationFn: (name: string) => createFolder(name, folder.id),
    onSuccess: async () => {
      setAdding(null);
      setError(null);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const rename = useMutation({
    mutationFn: (name: string) => renameFolder(folder.id, name),
    onSuccess: async () => {
      setRenaming(null);
      setError(null);
      await refresh();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: () => deleteFolder(folder.id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close this folder"
        onPress={onClose}
        style={[
          {
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.6)',
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: space.lg,
            paddingVertical: space.xl,
            // Above the floating ✦, which is the app's only other layer. Without
            // this it sat on top of the scrim, un-dimmed and still tappable —
            // photographed, and the whole point of the sheet is that nothing
            // else is competing for attention.
            zIndex: elevation.float + 1,
          },
          // Web only: react-native has no blur, and the scrim above is what
          // carries the effect without it.
          Platform.OS === 'web' ? ({ backdropFilter: 'blur(10px)' } as object) : null,
        ]}
      >
        {/* A press inside must not close it. An empty onPress is the whole
            reason this is a Pressable and not a View. */}
        <Pressable
          onPress={() => {}}
          style={{
            width: '100%',
            maxWidth: CONTENT_MAX_WIDTH,
            maxHeight: '100%',
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.bg,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.sm,
              padding: space.lg,
              borderBottomWidth: 1,
              borderBottomColor: t.border,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.title, { color: t.text }]} numberOfLines={2}>
                {folder.name}
              </Text>
              <Text style={[type.caption, { color: t.textMuted }]}>
                {folderMeta(inside.length, inside.reduce((n, s) => n + (statsBySet.get(s.id)?.due ?? 0), 0))}
                {children.length > 0 ? ` · ${children.length} folder${children.length === 1 ? '' : 's'}` : ''}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close this folder"
              onPress={onClose}
              hitSlop={8}
              style={{ padding: space.sm }}
            >
              <Text style={{ color: t.textMuted, fontSize: 20 }}>{GLYPH.close}</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{ padding: space.lg, gap: space.md }}
            keyboardShouldPersistTaps="handled"
          >
            {error ? <Notice tone="error">{error}</Notice> : null}

            {children.map((child) => {
              const childSets = setsInFolder(sets, child.id);
              return (
                <ListRow
                  key={child.id}
                  title={`📁  ${child.name}`}
                  meta={folderMeta(
                    childSets.length,
                    childSets.reduce((n, s) => n + (statsBySet.get(s.id)?.due ?? 0), 0),
                  )}
                  onPress={() => onOpenFolder(child)}
                />
              );
            })}

            {inside.length === 0 && children.length === 0 ? (
              <Body muted>
                Nothing in here yet. Hold a set on the home screen and drag it in, or use "Move to
                folder" on the set.
              </Body>
            ) : null}

            {inside.map((set) => {
              const stats = statsBySet.get(set.id);
              const cards = set.cardCount ?? 0;
              return (
                <ListRow
                  key={set.id}
                  title={formatSetTitle(set.title)}
                  meta={`${cards} card${cards === 1 ? '' : 's'}${stats?.due ? ` · ${stats.due} due today` : ''}`}
                  progress={cards > 0 && stats ? stats.known / cards : undefined}
                  onPress={() => onOpenSet(set.id)}
                />
              );
            })}

            {/* Making a folder inside this one — the thing the focused view was
                asked for. Offered only on a top-level folder: two levels is the
                rule, and `folders_shape_guard` in 0025 would refuse a third. */}
            {adding !== null ? (
              <>
                <Field
                  label="Folder inside this one"
                  value={adding}
                  onChangeText={setAdding}
                  placeholder="Week 1"
                  autoCapitalize="sentences"
                  maxLength={MAX_FOLDER_NAME}
                />
                <Button
                  label="Make it"
                  onPress={() => addSubfolder.mutate(adding)}
                  busy={addSubfolder.isPending}
                />
                <Button label="Cancel" variant="secondary" onPress={() => setAdding(null)} />
              </>
            ) : canHoldFolders(folder) ? (
              <Button label="+ Folder inside this one" variant="secondary" onPress={() => setAdding('')} />
            ) : (
              <Body muted>This is already inside a folder, so it can't hold more folders.</Body>
            )}

            {renaming !== null ? (
              <>
                <Field
                  label="Folder name"
                  value={renaming}
                  onChangeText={setRenaming}
                  autoCapitalize="sentences"
                  maxLength={MAX_FOLDER_NAME}
                />
                <Button label="Save name" onPress={() => rename.mutate(renaming)} busy={rename.isPending} />
                <Button label="Cancel" variant="secondary" onPress={() => setRenaming(null)} />
              </>
            ) : (
              <Button label="Rename folder" variant="secondary" onPress={() => setRenaming(folder.name)} />
            )}

            {confirmDelete ? (
              <>
                <Notice tone="warn">
                  Delete "{folder.name}"? Everything in it stays — the sets go back to your home
                  screen, and any folder inside becomes a folder of its own.
                </Notice>
                <Button label="Yes, delete the folder" onPress={() => remove.mutate()} busy={remove.isPending} />
                <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
              </>
            ) : (
              <Button label="Delete folder" variant="secondary" onPress={() => setConfirmDelete(true)} />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
