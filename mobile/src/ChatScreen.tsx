import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH } from './model';
import type { Draft, Workout } from './model';
import type { Program } from './programs';
import { applyWorkoutMessage, formatWorkoutMessage } from './workoutMessage';
import { buildHistorySuggestionIndex } from './messageSuggestions';
import { Button, Card } from './ui';
import { styles, colors } from './theme';
import { t } from './i18n';
import { insertAtSelection, sendOnce } from './chatInput';

type Props = { workouts: Workout[]; programs: Program[]; pending: number; draft: Draft | null; statusForWorkout(id: string): string; error: string | null; status: React.ReactNode; onDraftText(text: string): boolean; onRetryDraft(): boolean; onSend(text: string): boolean; onEdit(workout: Workout): void; onStructured(): void; account: React.ReactNode; };
const Message = memo(function Message({ item, onPress, delivery }: { item: Workout; onPress: (item: Workout) => void; delivery: string }) {
  const body = formatWorkoutMessage({ ...item, exercises: item.exercises.map(e => ({ ...e, sets: e.sets.map(s => ({ ...s, kg: String(s.kg), reps: String(s.reps) })) })) });
  return <Pressable accessibilityRole="button" accessibilityLabel={t.chatEditLabel(item.date, item.title || t.untitled)} onPress={() => onPress(item)} android_ripple={{ color: colors.border }} style={({ pressed }) => pressed && styles.pressed}>
    <Card><Text style={styles.title}>{item.date} · {item.title || t.untitled}</Text><Text style={styles.eyebrow}>{delivery}</Text><Text style={styles.text}>{body.text}</Text>{item.notes ? <Text style={styles.muted}>{item.notes}</Text> : null}</Card>
  </Pressable>;
});
export function ChatScreen({ workouts, programs, pending, draft, error, status, statusForWorkout, onDraftText, onRetryDraft, onSend, onEdit, onStructured, account }: Props) {
  const structuredMessage = draft && draft.exercises.length ? formatWorkoutMessage(draft) : null;
  const initial = draft?.messageText ?? (structuredMessage?.lossless ? structuredMessage.text : '');
  const [text, setText] = useState(initial);
  const textRef = useRef(initial);
  const input = useRef<TextInput>(null);
  const sending = useRef(false);
  const editRef = useRef(onEdit); editRef.current = onEdit;
  const stableEdit = useCallback((item: Workout) => editRef.current(item), []);
  const statusRef = useRef(statusForWorkout); statusRef.current = statusForWorkout;
  const stableStatus = useCallback((id: string) => statusRef.current(id), []);
  const [selection, setSelection] = useState({ start: initial.length, end: initial.length });
  const selectionRef = useRef(selection);
  const [draftWriteOk, setDraftWriteOk] = useState(true);
  const [showAccount, setShowAccount] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showPrograms, setShowPrograms] = useState(false);
  const [weightSuggestions, setWeightSuggestions] = useState<number[]>([]);
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
  const renderItem = useCallback(({ item }: { item: Workout }) => <Message item={item} onPress={stableEdit} delivery={stableStatus(item.id)} />, [stableEdit, stableStatus]);
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}><View style={styles.between}><Text style={styles.brand}>{t.appTitle}</Text><Text style={styles.eyebrow}>{t.localBadge}</Text></View><View style={styles.row}><Button label={t.accountPanel} secondary onPress={() => setShowAccount(value => !value)} /><Text style={styles.muted}>{t.pending(pending)}</Text></View>{showAccount && account}{draft && <Button label={t.chatAdvancedEditor} secondary onPress={onStructured} />}</View>
    <FlatList data={workouts} keyExtractor={item => item.id} renderItem={renderItem} keyboardShouldPersistTaps="always" keyboardDismissMode="on-drag" contentContainerStyle={styles.content} ListEmptyComponent={<View style={styles.empty}><Text style={styles.title}>{t.emptyTitle}</Text><Text style={styles.muted}>{t.chatTryExample}</Text></View>} />
    <View style={styles.composer}>
      {status}{!draftWriteOk && <View style={styles.row}><Text style={[styles.error, styles.flex]} accessibilityLiveRegion="polite">{t.chatDraftWriteFailed}</Text><Button label={t.retry} secondary onPress={() => setDraftWriteOk(onRetryDraft())} /></View>}{draft?.messageText && !text && <Text style={styles.muted}>{t.chatDraftResume}</Text>}
      {!!suggestions?.recentExercises().length && <><Button label={showSuggestions ? t.chatHideSuggestions : t.chatSuggestions} secondary onPress={() => setShowSuggestions(value => !value)} />{showSuggestions && <FlatList horizontal keyboardShouldPersistTaps="always" data={suggestions.recentExercises().slice(0, 5)} keyExtractor={item => item.name} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={t.chatInsertExercise(item.name)} android_ripple={{ color: colors.border }} style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]} onPress={() => accept(item.name)}><Text style={styles.text}>{item.name}</Text></Pressable>} />}</>}
      <Button label={t.chatSuggestWeights} secondary onPress={() => {
        const base = draft ?? { id: randomUUID(), date: new Date().toISOString().slice(0, 10), title: '', notes: '', exercises: [] };
        const parsed = applyWorkoutMessage(textRef.current, base);
        if (!parsed.ok || !parsed.draft.exercises.length) { setWeightSuggestions([]); return; }
        const latest = parsed.draft.exercises.at(-1)!;
        const index = draft && parsed.draft.title === draft.title ? suggestions : buildHistorySuggestionIndex(parsed.draft, workouts);
        setWeightSuggestions(index?.weightsFor(latest) ?? []);
      }} />
      {!!programs.length && <><Button label={showPrograms ? t.chatHidePrograms : t.chatShowPrograms} secondary onPress={() => setShowPrograms(value => !value)} />{showPrograms && <View style={styles.field}>{programs.map(program => <Pressable key={program.id} accessibilityRole="button" accessibilityLabel={t.chatAppendProgram(program.name)} android_ripple={{ color: colors.border }} style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]} onPress={() => {
        const existing = textRef.current.toLocaleLowerCase();
        const lines = program.entries.filter(entry => !existing.includes(entry.name.toLocaleLowerCase())).map(entry => `${entry.name} ${Array.from({ length: entry.set_count }, () => 'W-').join(' ')}`).join('\n');
        if (!lines) return;
        const prefix = textRef.current && !textRef.current.endsWith('\n') ? '\n' : '';
        const cursor = textRef.current.length; selectionRef.current = { start: cursor, end: cursor };
        accept(`${prefix}${lines}`);
      }}><Text style={styles.text}>{program.name}</Text></Pressable>)}</View>}</>}
      {!!weightSuggestions.length && <FlatList horizontal keyboardShouldPersistTaps="always" data={weightSuggestions} keyExtractor={(value, index) => `${value}-${index}`} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={t.chatInsertWeight(item)} android_ripple={{ color: colors.border }} style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]} onPress={() => accept(`${item}-`)}><Text style={styles.text}>{item} kg</Text></Pressable>} />}
      <TextInput ref={input} value={text} onChangeText={setValue} onSelectionChange={event => { selectionRef.current = event.nativeEvent.selection; setSelection(event.nativeEvent.selection); }} selection={selection} multiline maxLength={MAX_TEXT_LENGTH} placeholder={t.chatComposerPlaceholder} placeholderTextColor={colors.muted} accessibilityLabel={t.chatInputLabel} style={[styles.input, styles.composerInput]} textAlignVertical="top" returnKeyType="default" blurOnSubmit={false} />
      <View style={styles.row}><Text style={[styles.muted, styles.flex]}>{t.chatSyntaxHint}</Text><Button label={t.chatSend} disabled={!text.trim()} onPress={send} /></View>
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    </View>
  </KeyboardAvoidingView>;
}
