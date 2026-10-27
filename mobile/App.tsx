import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { openDatabaseSync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Alert, AppState, BackHandler, FlatList, Linking, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Programs } from './src/Programs';
import { createProgramStore } from './src/programStore';
import type { ProgramStore } from './src/programStore';
import type { Program } from './src/programs';
import { Editor } from './src/Editor';
import { ChatScreen } from './src/ChatScreen';
import { applyWorkoutMessage } from './src/workoutMessage';
import { createAutoSync } from './src/autoSync';
import * as Network from 'expo-network';
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
  const legacyStore = useRef<ReturnType<typeof createStore> | null>(null);
  const latestDraft = useRef<Draft | null>(null);
  const latestSyncError = useRef<ErrorCode | null>(null);
  const autoSync = useRef(createAutoSync({ run: async () => { latestSyncError.current = null; await sync.run(); return latestSyncError.current; } }));
  const store = useRef<AccountStore | null>(null);
  const programStore = useRef<ProgramStore | null>(null);
  const [programMenu, setProgramMenu] = useState(false);
  const api = useRef(createApi(base)).current;
  const auth = useRef(createAuth(base, api, {
    get: SecureStore.getItemAsync, set: SecureStore.setItemAsync, remove: SecureStore.deleteItemAsync,
  })).current;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [legacy, setLegacy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftSaved, setDraftSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<ErrorCode | null>(null);
  const alive = useRef(true);
  const sync = useRef(createSync(reload, code => { latestSyncError.current = code; if (alive.current) setSyncError(code); })).current;

  function reload() {
    if (!alive.current) return;
    try {
      const data = store.current ? store.current.load() : legacyStore.current?.load();
      if (!data) return;
      setWorkouts(data.workouts); setRows(store.current?.rows() ?? []);
      setPrograms(programStore.current?.load() ?? []);
      // Draft content belongs to the editor; sync never replaces it.
      const old = store.current ? store.current.legacy() : (legacyStore.current?.load() ?? { workouts: [], draft: null }); setLegacy(!!old.workouts.length || !!old.draft);
    } catch { setError(t.loadFailed); }
  }
  function activate(next: Session | null) {
    sync.activate(null); autoSync.current.setAccountGeneration(null);
    setProgramMenu(false); setEditing(false); setError(null); setSyncError(null); setDraftSaved(true);
    setSession(next); setWorkouts([]); setRows([]); setPrograms([]); setDraft(null); latestDraft.current = null;
    if (!next) { store.current = null; programStore.current = null; if (legacyStore.current) { const local = legacyStore.current.load(); setWorkouts(local.workouts); setDraft(local.draft); latestDraft.current = local.draft; setLegacy(!!local.workouts.length || !!local.draft); } return; }
    const scoped = createAccountStore(database.current!, accountKey(next));
    store.current = scoped;
    programStore.current = createProgramStore(database.current!, accountKey(next));
    const data = scoped.load(); setDraft(data.draft); latestDraft.current = data.draft; reload();
    sync.activate({ session: next, store: scoped, api, programs: programStore.current });
    autoSync.current.setAccountGeneration(accountKey(next));
    void sync.run();
  }
  async function load() {
    setPhase('loading');
    try {
      database.current ??= openDatabaseSync(DATABASE_NAME);
      legacyStore.current = createStore(database.current);
      const restored = await auth.restore();
      if (!alive.current) return;
      activate(restored.session); setLogin(restored.login); setPhase('ready');
    } catch { if (alive.current) setPhase('failed'); }
  }
  useEffect(() => {
    alive.current = true; void load();
    let disposed = false;
    autoSync.current.setAppActive(AppState.currentState === 'active');
    const appState = AppState.addEventListener('change', state => autoSync.current.setAppActive(state === 'active'));
    void Network.getNetworkStateAsync().then((state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }) => { if (!disposed) autoSync.current.setConnectivity(state.isConnected === false || state.isInternetReachable === false ? 'offline' : state.isConnected && state.isInternetReachable ? 'online' : 'unknown'); }).catch(() => autoSync.current.setConnectivity('unknown'));
    const network = Network.addNetworkStateListener((state: { isConnected?: boolean | null; isInternetReachable?: boolean | null }) => autoSync.current.setConnectivity(state.isConnected === false || state.isInternetReachable === false ? 'offline' : state.isConnected && state.isInternetReachable ? 'online' : 'unknown'));
    return () => { disposed = true; appState.remove(); network.remove(); autoSync.current.dispose(); alive.current = false; sync.activate(null); database.current?.closeSync(); database.current = null; };
  }, []);
  useEffect(() => {
    if (!editing && !programMenu) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { setProgramMenu(false); setEditing(false); setError(null); return true; });
    return () => subscription.remove();
  }, [editing, programMenu]);
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
      } else if (session) autoSync.current.request();
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
    latestDraft.current = next; setDraft(next); setError(null);
    try { (store.current ?? legacyStore.current)!.writeDraft(next); setDraftSaved(true); } catch { setDraftSaved(false); }
  }
  function messageDraft(text: string): boolean {
    const current = latestDraft.current ?? draft ?? newDraft(randomUUID());
    const next = { ...current, messageText: text }; latestDraft.current = next;
    try { (store.current ?? legacyStore.current)!.writeDraft(next); return true; } catch { return false; }
  }
  function sendMessage(text: string): boolean {
    const current = latestDraft.current ?? draft ?? newDraft(randomUUID());
    const parsed = applyWorkoutMessage(text, current);
    if (!parsed.ok) { setError(`${parsed.issue.text}${parsed.issue.token ? `: ${parsed.issue.token}` : ''}`); return false; }
    try {
      const target = store.current ?? legacyStore.current; if (!target) throw new Error('storage unavailable');
      target.save(parsed.draft); setError(null); setDraft(null); latestDraft.current = null; setDraftSaved(true); reload();
      if (store.current) autoSync.current.request();
      return true;
    } catch { setError(t.saveFailed); return false; }
  }
  function openStructured() {
    if (draft) { latestDraft.current = draft; setEditing(true); return; }
    change(newDraft(randomUUID())); setEditing(true);
  }
  function open(workout?: Workout) {
    if (draft) {
      if (workout) Alert.alert(t.draftTitle, t.draftHint, [{ text: t.cancel, style: 'cancel' }]);
      else setEditing(true);
      return;
    }
    change(workout ? toDraft(workout) : newDraft(randomUUID())); setEditing(true);
  }
  function save(currentDraft: Draft) {
    const issue = validateDraft(currentDraft);
    if (issue) { setError(validationText(issue)); return; }
    try {
      (store.current ?? legacyStore.current)!.save(currentDraft); reload(); setDraft(null); latestDraft.current = null; setEditing(false); setDraftSaved(true); setError(null); if (store.current) autoSync.current.request();
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
  if (!session) return <ChatScreen workouts={workouts} pending={0} draft={draft} error={error} status={draftStatus} onDraftText={messageDraft} onSend={sendMessage} onEdit={open} onPrograms={() => {}} onStructured={openStructured} account={<>{authControls}<Text style={styles.muted}>{t.signedOut}</Text>{legacy && <Button label={t.import} secondary onPress={importLegacy} />}</>} />;
  if (programMenu && programStore.current) return <View style={styles.flex}>
    {syncError && <Text style={styles.error}>{t.errors[syncError]}</Text>}
    <Programs key={accountKey(session)} store={programStore.current} onBack={() => setProgramMenu(false)} onMutation={() => { reload(); void sync.run(); }} onResolve={id => sync.resolveProgram(id).then(() => { reload(); })} />
  </View>;
  if (editing && draft) return <Editor draft={draft} history={workouts} programs={programs} onChange={change} onSave={save} onDiscard={discard}
    onDelete={workouts.some(w => w.id === draft.id) ? remove : undefined} error={error} status={draftStatus}
    onBack={() => { setEditing(false); setError(null); }} />;
  if (!editing) return <ChatScreen workouts={workouts} pending={rows.filter(row => row.pending).length} draft={draft} error={error} status={draftStatus} onDraftText={messageDraft} onSend={sendMessage} onEdit={open} onPrograms={() => setProgramMenu(true)} onStructured={openStructured} account={<>{authControls}{rows.filter(row => row.error).map(row => <View key={row.workout.id} style={styles.field}><Text style={styles.error}>{t.errors[row.error as ErrorCode] ?? t.errors.request_failed}</Text><Button label={t.conflictAction} onPress={() => resolve(row.workout.id)} /></View>)}{legacy && <Button label={t.import} secondary onPress={importLegacy} />}</>} />;
  return <FlatList data={workouts} keyExtractor={w => w.id} contentContainerStyle={styles.content}
    ListHeaderComponent={<View style={styles.field}>
      <View style={styles.between}><Text style={styles.brand}>{t.appTitle}</Text><Text style={styles.eyebrow}>{t.localBadge}</Text></View>
      {authControls}
      <Text style={styles.muted}>{t.pending(rows.filter(r => r.pending).length)}</Text>
      <Button label={t.programs} secondary onPress={() => setProgramMenu(true)} />
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
      <Card><Text style={styles.title}>{item.date} · {item.title || t.untitled}</Text>
        {!!t.intake(item.kcal, item.proteinG) && <Text style={styles.muted}>{t.intake(item.kcal, item.proteinG)}</Text>}
        <Text style={styles.muted}>{t.summary(item.exercises.length, setCount(item))}</Text>
        <Text style={styles.text}>{item.exercises.map(e => `${e.name} ${e.sets.map(s => t.setPreview(String(s.kg), String(s.reps))).join(t.setPreviewSeparator)}`).join('\n')}</Text>
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
