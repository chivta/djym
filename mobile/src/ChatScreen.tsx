import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import type { Draft, Workout } from './model';
import { formatWorkoutMessage } from './workoutMessage';
import { buildHistorySuggestionIndex } from './messageSuggestions';
import { Button, Card } from './ui';
import { styles, colors } from './theme';
import { t } from './i18n';
import { insertAtSelection, sendOnce } from './chatInput';

type Props = { workouts: Workout[]; pending: number; draft: Draft | null; error: string | null; status: React.ReactNode; onDraftText(text: string): boolean; onSend(text: string): boolean; onEdit(workout: Workout): void; onPrograms?: () => void; onStructured(): void; account: React.ReactNode; };
const Message = memo(function Message({ item, onPress }: { item: Workout; onPress: (item: Workout) => void }) {
  const body = formatWorkoutMessage({ ...item, exercises: item.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, kg: String(s.kg), reps: String(s.reps) })) })) });
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.date}, ${item.title || t.untitled}. Edit workout`} onPress={() => onPress(item)} android_ripple={{ color: colors.border }} style={({ pressed }) => pressed && styles.pressed}>
    <Card><Text style={styles.title}>{item.date} · {item.title || t.untitled}</Text><Text style={styles.text}>{body.text}</Text>{item.notes ? <Text style={styles.muted}>{item.notes}</Text> : null}</Card>
  </Pressable>;
});
export function ChatScreen({ workouts, pending, draft, error, status, onDraftText, onSend, onEdit, onPrograms, onStructured, account }: Props) {
  const initial = draft?.messageText ?? '';
  const [text, setText] = useState(initial);
  const textRef = useRef(initial);
  const input = useRef<TextInput>(null);
  const sending = useRef(false);
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const stableEdit = useCallback((item: Workout) => editRef.current(item), []);
  const [selection, setSelection] = useState({ start: initial.length, end: initial.length });
  const selectionRef = useRef(selection);
  const [draftWriteOk, setDraftWriteOk] = useState(true);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestions = useMemo(() => draft ? buildHistorySuggestionIndex(draft, workouts) : null, [draft?.id, draft?.title, workouts]);
  const accept = useCallback((value: string) => {
    const inserted = insertAtSelection(textRef.current, selectionRef.current, value);
    textRef.current = inserted.text; setText(inserted.text); setDraftWriteOk(onDraftText(inserted.text));
    selectionRef.current = inserted.selection; setSelection(inserted.selection);
  }, [onDraftText]);
  const setValue = useCallback((value: string) => { textRef.current = value; setText(value); setDraftWriteOk(onDraftText(value)); }, [onDraftText]);
  const send = useCallback(() => {
    if (!textRef.current.trim()) return;
    sendOnce(sending, () => { if (onSend(textRef.current)) { textRef.current = ''; setText(''); selectionRef.current = { start: 0, end: 0 }; setSelection(selectionRef.current); } });
  }, [onSend]);
  const renderItem = useCallback(({ item }: { item: Workout }) => <Message item={item} onPress={stableEdit} />, [stableEdit]);
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}><View style={styles.between}><Text style={styles.brand}>{t.appTitle}</Text><Text style={styles.eyebrow}>{t.localBadge}</Text></View>{account}<View style={styles.row}>{onPrograms && <Button label={t.programs} secondary onPress={onPrograms} />}<Text style={styles.muted}>{t.pending(pending)}</Text></View>{draft && <Button label="Advanced structured editor" secondary onPress={onStructured} />}</View>
    <FlatList data={workouts} keyExtractor={item => item.id} renderItem={renderItem} keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag" contentContainerStyle={styles.content} ListEmptyComponent={<View style={styles.empty}><Text style={styles.title}>{t.emptyTitle}</Text><Text style={styles.muted}>Try: Bench press 60-8 -7 -6</Text></View>} />
    <View style={styles.composer}>
      {status}{!draftWriteOk && <Text style={styles.error} accessibilityLiveRegion="polite">Draft could not be saved. Keep the app open and retry.</Text>}{draft?.messageText && !text && <Text style={styles.muted}>Unfinished message saved locally. Resume typing below.</Text>}
      {!!suggestions?.recentExercises().length && <><Button label={showSuggestions ? 'Hide suggestions' : 'Show exercise suggestions'} secondary onPress={() => setShowSuggestions(value => !value)} />{showSuggestions && <FlatList horizontal keyboardShouldPersistTaps="always" data={suggestions.recentExercises().slice(0, 5)} keyExtractor={item => item.name} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`Insert ${item.name}`} android_ripple={{ color: colors.border }} style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]} onPress={() => accept(item.name)}><Text style={styles.text}>{item.name}</Text></Pressable>} />}</> }
      <TextInput ref={input} value={text} onChangeText={setValue} onSelectionChange={event => { selectionRef.current = event.nativeEvent.selection; setSelection(event.nativeEvent.selection); }} selection={selection} multiline maxLength={20000} placeholder="Workout message…" placeholderTextColor={colors.muted} accessibilityLabel="Workout message" style={[styles.input, styles.composerInput]} textAlignVertical="top" returnKeyType="default" blurOnSubmit={false} />
      <View style={styles.row}><Text style={[styles.muted, styles.flex]}>Exercise 60-8 -7 · headers support | note</Text><Button label="Send" disabled={!text.trim()} onPress={send} /></View>
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    </View>
  </KeyboardAvoidingView>;
}
