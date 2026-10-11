import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import { openDatabaseSync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Alert, BackHandler, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Editor } from './src/Editor';
import { t, validationText } from './src/i18n';
import { newDraft, setCount, toDraft, validateDraft } from './src/model';
import type { Draft, Workout } from './src/model';
import { createStore, DATABASE_NAME } from './src/storage';
import type { Store } from './src/storage';
import { styles } from './src/theme';
import { Button, Card } from './src/ui';

function WorkoutLog() {
  const database = useRef<SQLiteDatabase | null>(null);
  const store = useRef<Store | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setPhase('loading');
    try {
      database.current ??= openDatabaseSync(DATABASE_NAME);
      const nextStore = createStore(database.current);
      const data = nextStore.load();
      store.current = nextStore;
      setWorkouts(data.workouts);
      setDraft(data.draft);
      setDraftSaved(true);
      setPhase('ready');
    } catch {
      store.current = null;
      setPhase('failed');
    }
  }
  useEffect(() => {
    load();
    return () => { database.current?.closeSync(); database.current = null; };
  }, []);
  useEffect(() => {
    if (!editing) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setEditing(false);
      setError(null);
      return true;
    });
    return () => subscription.remove();
  }, [editing]);

  function change(next: Draft) {
    setDraft(next);
    setError(null);
    try {
      store.current!.writeDraft(next);
      setDraftSaved(true);
    } catch {
      setDraftSaved(false);
    }
  }
  function open(workout?: Workout) {
    if (draft) {
      if (workout) Alert.alert(t.draftTitle, t.draftHint, [{ text: t.cancel, style: 'cancel' }]);
      else setEditing(true);
      return;
    }
    change(workout ? toDraft(workout) : newDraft(randomUUID()));
    setEditing(true);
  }
  function save() {
    if (!draft) return;
    const issue = validateDraft(draft);
    if (issue) { setError(validationText(issue)); return; }
    try {
      const saved = store.current!.save(draft);
      setWorkouts(previous => [saved, ...previous.filter(workout => workout.id !== saved.id)].sort((a, b) => b.date.localeCompare(a.date)));
      setDraft(null);
      setEditing(false);
      setDraftSaved(true);
      setError(null);
    } catch {
      setError(t.saveFailed);
    }
  }
  function discard() {
    Alert.alert(t.discardTitle, t.discardBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.discard, style: 'destructive', onPress: () => {
        try {
          store.current!.clearDraft();
          setDraft(null);
          setEditing(false);
          setDraftSaved(true);
          setError(null);
        } catch { setError(t.discardFailed); }
      } },
    ]);
  }
  function remove() {
    if (!draft) return;
    const id = draft.id;
    Alert.alert(t.deleteTitle, t.deleteBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.delete, style: 'destructive', onPress: () => {
        try {
          store.current!.remove(id);
          setWorkouts(previous => previous.filter(workout => workout.id !== id));
          setDraft(null);
          setEditing(false);
          setDraftSaved(true);
          setError(null);
        } catch { setError(t.deleteFailed); }
      } },
    ]);
  }
  const draftStatus = <View style={styles.field}>
    <Text style={draftSaved ? styles.muted : styles.error} accessibilityLiveRegion="polite">{draftSaved ? t.draftSaved : t.draftFailed}</Text>
    {!draftSaved && draft && <Button label={t.retry} secondary onPress={() => change(draft)} />}
  </View>;

  if (phase !== 'ready') return <View style={styles.center}>
    <Text style={styles.heading}>{t.appTitle}</Text>
    <Text style={phase === 'failed' ? styles.error : styles.muted}>{phase === 'failed' ? t.loadFailed : t.loading}</Text>
    {phase === 'failed' && <Button label={t.retry} onPress={load} />}
  </View>;
  if (editing && draft) return <Editor draft={draft} onChange={change} onSave={save} onDiscard={discard}
    onDelete={workouts.some(workout => workout.id === draft.id) ? remove : undefined} error={error} status={draftStatus}
    onBack={() => { setEditing(false); setError(null); }} />;

  return <FlatList data={workouts} keyExtractor={workout => workout.id} contentContainerStyle={styles.content}
    ListHeaderComponent={<View style={styles.field}>
      <View style={styles.between}>
        <Text style={styles.brand}>{t.appTitle}</Text>
        <Text style={styles.eyebrow}>{t.localBadge}</Text>
      </View>
      <Text style={styles.muted}>{t.tagline}</Text>
      <Button label={draft ? t.resume : t.newWorkout} onPress={() => open()} />
      {draft && <Card>
        <Text style={styles.title}>{draft.title || t.draftTitle}</Text>
        <Text style={styles.muted}>{draft.date}</Text>
        {draftStatus}
        <Text style={styles.muted}>{t.draftHint}</Text>
        <Button label={t.discard} secondary onPress={discard} />
      </Card>}
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      <View style={styles.between}>
        <Text style={styles.heading}>{t.history}</Text>
        <Text style={styles.muted}>{t.workoutCount(workouts.length)}</Text>
      </View>
    </View>}
    ListEmptyComponent={<View style={styles.empty}>
      <Text style={styles.title}>{t.emptyTitle}</Text>
      <Text style={styles.muted}>{t.emptyBody}</Text>
    </View>}
    ListFooterComponent={<Text style={styles.muted}>{t.localHint}</Text>}
    renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.date}, ${item.title || t.untitled}, ${t.summary(item.exercises.length, setCount(item))}`}
      onPress={() => open(item)} style={({ pressed }) => pressed && styles.pressed}>
      <Card>
        <Text style={styles.eyebrow}>{item.date}</Text>
        <Text style={styles.title}>{item.title || t.untitled}</Text>
        <Text style={styles.muted}>{t.summary(item.exercises.length, setCount(item))}</Text>
        <Text style={styles.text} numberOfLines={2}>{item.exercises.map(entry => entry.name).join(t.exerciseSeparator)}</Text>
        {!!item.notes && <Text style={styles.muted} numberOfLines={2}>{item.notes}</Text>}
      </Card>
    </Pressable>} />;
}

export default function App() {
  return <SafeAreaProvider>
    <SafeAreaView style={styles.screen}>
      <StatusBar style="light" />
      <WorkoutLog />
    </SafeAreaView>
  </SafeAreaProvider>;
}
