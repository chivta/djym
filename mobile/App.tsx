import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { openDatabaseSync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Alert, AppState, BackHandler, FlatList, Linking, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Editor } from './src/Editor';
import { t, validationText } from './src/i18n';
import { newDraft, setCount, toDraft, validateDraft } from './src/model';
import type { Draft, Workout } from './src/model';
import { createStore, DATABASE_NAME } from './src/storage';
import { accountKey, createAccountStore } from './src/accountStore';
import type { AccountStore, Row } from './src/accountStore';
import { apiURL, ApiError, createApi } from './src/api';
import type { ErrorCode, Login, Session } from './src/api';
import { createAuth } from './src/auth';
import { createSync } from './src/sync';
import { styles } from './src/theme';
import { Button, Card } from './src/ui';

function WorkoutLog({ base }: { base: string }) {
  const database = useRef<SQLiteDatabase | null>(null);
  const store = useRef<AccountStore | null>(null);
  const api = useRef(createApi(base)).current;
  const auth = useRef(createAuth(base, api, {
    get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync,
  })).current;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [legacy, setLegacy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<ErrorCode | null>(null);
  const alive = useRef(true);
  const sync = useRef(createSync(reload, code => { if (alive.current) setSyncError(code); })).current;

  function reload() {
    if (!alive.current || !store.current) return;
    try {
      const data = store.current.load();
      setWorkouts(data.workouts); setRows(store.current.rows());
      // Draft content belongs to the editor; sync never replaces it.
      const old = store.current.legacy(); setLegacy(!!old.workouts.length || !!old.draft);
    } catch { setError(t.loadFailed); }
  }
  function activate(next: Session | null) {
    sync.activate(null);
    setEditing(false); setError(null); setSyncError(null); setDraftSaved(true);
    setSession(next); setWorkouts([]); setRows([]); setDraft(null);
    if (!next) { store.current = null; return; }
    const scoped = createAccountStore(database.current!, accountKey(next));
    store.current = scoped;
    const data = scoped.load(); setDraft(data.draft); reload();
    sync.activate({ session: next, store: scoped, api });
    void sync.run();
  }
  async function load() {
    setPhase('loading');
    try {
      database.current ??= openDatabaseSync(DATABASE_NAME);
      createStore(database.current);
      const restored = await auth.restore();
      if (!alive.current) return;
      activate(restored.session); setLogin(restored.login); setPhase('ready');
    } catch { if (alive.current) setPhase('failed'); }
  }
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; sync.activate(null); database.current?.closeSync(); database.current = null; };
  }, []);
  useEffect(() => {
    if (!editing) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setEditing(false); setError(null); return true; });
    return () => subscription.remove();
  }, [editing]);
  useEffect(() => {
    let disposed = false;
    async function foreground() {
      if (AppState.currentState !== 'active') return;
      if (login) {
        try {
          const next = await auth.poll();
          if (disposed || !alive.current) return;
          if (next) { setLogin(null); activate(next); }
        } catch (e) {
          if (!disposed) {
            const code = e instanceof ApiError ? e.code : 'request_failed'; setSyncError(code);
            if (code === 'login_expired' || code === 'login_invalid') { setLogin(null); void auth.cancel(); }
          }
        }
      } else if (session) void sync.run();
    }
    const interval = setInterval(() => { void foreground(); }, login ? 2000 : 30000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void foreground(); });
    void foreground();
    return () => { disposed = true; clearInterval(interval); subscription.remove(); };
  }, [login, session]);
  async function signIn() {
    setSyncError(null);
    try {
      const next = await auth.start();
      if (!next || !alive.current) return;
      setLogin(next); await Linking.openURL(next.bot_url);
    } catch (e) { setSyncError(e instanceof ApiError ? e.code : 'request_failed'); }
  }
  async function cancelLogin() { try { await auth.cancel(); setLogin(null); } catch { setSyncError('request_failed'); } }
  async function logout() {
    const old = session;
    activate(null); setLogin(null);
    try { await auth.logout(old); } catch { setSyncError('request_failed'); }
  }
  function change(next: Draft) {
    setDraft(next); setError(null);
    try { store.current!.writeDraft(next); setDraftSaved(true); } catch { setDraftSaved(false); }
  }
  function open(workout?: Workout) {
    if (draft) {
      if (workout) Alert.alert(t.draftTitle, t.draftHint, [{ text: t.cancel, style: 'cancel' }]);
      else setEditing(true);
      return;
    }
    change(workout ? toDraft(workout) : newDraft(randomUUID())); setEditing(true);
  }
  function save() {
    if (!draft) return;
    const issue = validateDraft(draft);
    if (issue) { setError(validationText(issue)); return; }
    try {
      store.current!.save(draft); reload(); setDraft(null); setEditing(false); setDraftSaved(true); setError(null); void sync.run();
    } catch { setError(t.saveFailed); }
  }
  function discard() {
    const scoped = store.current;
    Alert.alert(t.discardTitle, t.discardBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.discard, style: 'destructive', onPress: () => {
        if (store.current !== scoped) return;
        try { store.current!.clearDraft(); setDraft(null); setEditing(false); setDraftSaved(true); setError(null); }
        catch { setError(t.discardFailed); }
      } },
    ]);
  }
  function remove() {
    if (!draft) return;
    const id = draft.id;
    const scoped = store.current;
    Alert.alert(t.deleteTitle, t.deleteBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.delete, style: 'destructive', onPress: () => {
        if (store.current !== scoped) return;
        try { store.current!.remove(id); reload(); setDraft(null); setEditing(false); setDraftSaved(true); setError(null); void sync.run(); }
        catch { setError(t.deleteFailed); }
      } },
    ]);
  }
  function importLegacy() {
    const scoped = store.current;
    if (!session) return;
    Alert.alert(t.importTitle, t.importBody(session.userId, base), [{ text: t.cancel, style: 'cancel' }, { text: t.import, onPress: () => {
      if (store.current !== scoped) return;
      try { store.current!.importLegacy(randomUUID); setDraft(store.current!.load().draft); reload(); void sync.run(); }
      catch { setError(t.importFailed); }
    } }]);
  }
  function resolve(id: string) {
    const scoped = store.current;
    Alert.alert(t.conflictTitle, t.conflictBody, [{ text: t.cancel, style: 'cancel' }, { text: t.conflictAction, style: 'destructive', onPress: () => {
      if (store.current !== scoped) return;
      void sync.resolve(id).then(() => { if (store.current === scoped && scoped && alive.current) setDraft(scoped.load().draft); });
    } }]);
  }
  const draftStatus = <View style={styles.field}>
    <Text style={draftSaved ? styles.muted : styles.error} accessibilityLiveRegion="polite">{draftSaved ? t.draftSaved : t.draftFailed}</Text>
    {!draftSaved && draft && <Button label={t.retry} secondary onPress={() => change(draft)} />}
  </View>;
  const authControls = <View style={styles.field}>
    {session && <><Text style={styles.muted}>{t.account(session.userId)}</Text><Button label={t.logout} secondary onPress={() => { void logout(); }} /></>}
    {(!session || syncError === 'unauthorized') && !login && <Button label={t.login} onPress={() => { void signIn(); }} />}
    {login && <><Text style={styles.muted}>{t.loginWaiting}</Text><Button label={t.openTelegram} onPress={() => { void Linking.openURL(login.bot_url).catch(() => setSyncError('request_failed')); }} /><Button label={t.cancel} secondary onPress={() => { void cancelLogin(); }} /></>}
    {syncError && <Text style={styles.error} accessibilityRole="alert">{t.errors[syncError]}</Text>}
  </View>;
  if (phase !== 'ready') return <View style={styles.center}>
    <Text style={styles.heading}>{t.appTitle}</Text><Text style={phase === 'failed' ? styles.error : styles.muted}>{phase === 'failed' ? t.loadFailed : t.loading}</Text>
    {phase === 'failed' && <Button label={t.retry} onPress={() => { void load(); }} />}
  </View>;
  if (!session) return <View style={styles.content}><Text style={styles.heading}>{t.appTitle}</Text><Text style={styles.muted}>{t.signedOut}</Text>{authControls}</View>;
  if (editing && draft) return <Editor draft={draft} onChange={change} onSave={save} onDiscard={discard}
    onDelete={workouts.some(w => w.id === draft.id) ? remove : undefined} error={error} status={draftStatus}
    onBack={() => { setEditing(false); setError(null); }} />;
  return <FlatList data={workouts} keyExtractor={w => w.id} contentContainerStyle={styles.content}
    ListHeaderComponent={<View style={styles.field}>
      <View style={styles.between}><Text style={styles.brand}>{t.appTitle}</Text><Text style={styles.eyebrow}>{t.localBadge}</Text></View>
      {authControls}
      <Text style={styles.muted}>{t.pending(rows.filter(r => r.pending).length)}</Text>
      <Button label={t.refresh} secondary onPress={() => { void sync.run(); }} />
      {legacy && <Button label={t.import} secondary onPress={importLegacy} />}
      {rows.filter(r => r.error).map(r => <Card key={r.workout.id}>
        <Text style={styles.title}>{r.workout.date}</Text>
        <Text style={styles.error}>{t.errors[r.error as ErrorCode] ?? t.errors.request_failed}</Text>
        <Button label={t.conflictAction} onPress={() => resolve(r.workout.id)} />
      </Card>)}
      <Button label={draft ? t.resume : t.newWorkout} onPress={() => open()} />
      {draft && <Card><Text style={styles.title}>{draft.title || t.draftTitle}</Text><Text style={styles.muted}>{draft.date}</Text>{draftStatus}<Text style={styles.muted}>{t.draftHint}</Text><Button label={t.discard} secondary onPress={discard} /></Card>}
      {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
      <View style={styles.between}><Text style={styles.heading}>{t.history}</Text><Text style={styles.muted}>{t.workoutCount(workouts.length)}</Text></View>
    </View>}
    ListEmptyComponent={<View style={styles.empty}><Text style={styles.title}>{t.emptyTitle}</Text><Text style={styles.muted}>{t.emptyBody}</Text></View>}
    ListFooterComponent={<Text style={styles.muted}>{t.localHint}</Text>}
    renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.date}, ${item.title || t.untitled}, ${t.summary(item.exercises.length, setCount(item))}`}
      onPress={() => open(item)} style={({ pressed }) => pressed && styles.pressed}>
      <Card><Text style={styles.eyebrow}>{item.date}</Text><Text style={styles.title}>{item.title || t.untitled}</Text>
        <Text style={styles.muted}>{t.summary(item.exercises.length, setCount(item))}</Text>
        <Text style={styles.text} numberOfLines={2}>{item.exercises.map(e => e.name).join(t.exerciseSeparator)}</Text>
        {!!item.notes && <Text style={styles.muted} numberOfLines={2}>{item.notes}</Text>}
      </Card>
    </Pressable>} />;
}
export default function App() {
  let base: string | null = null;
  try { base = apiURL(process.env.EXPO_PUBLIC_API_URL); } catch { /* Configuration is required, not a runtime fallback. */ }
  return <SafeAreaProvider><SafeAreaView style={styles.screen}><StatusBar style="light" />
    {base ? <WorkoutLog base={base} /> : <View style={styles.center}><Text style={styles.error}>{t.errors.configuration}</Text></View>}
  </SafeAreaView></SafeAreaProvider>;
}
