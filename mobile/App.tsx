import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { openDatabaseSync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Alert, AppState, BackHandler, Linking, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Programs } from './src/Programs';
import { createProgramStore } from './src/programStore';
import type { ProgramStore } from './src/programStore';
import type { Program } from './src/programs';
import { Editor } from './src/Editor';
import { ChatScreen } from './src/ChatScreen';
import { createChatMessageHandlers } from './src/chatInput';
import { applyWorkoutMessage } from './src/workoutMessage';
import { createAutoSync } from './src/autoSync';
import * as Network from 'expo-network';
import { t, validationText } from './src/i18n';
import { newDraft, toDraft, validateDraft } from './src/model';
import type { Draft, Workout } from './src/model';
import { createStore, DATABASE_NAME } from './src/storage';
import { accountKey, createAccountStore } from './src/accountStore';
import type { AccountStore, Row } from './src/accountStore';
import { apiURL, ApiError, createApi } from './src/api';
import type { ErrorCode, Login, Session } from './src/api';
import { createAuth } from './src/auth';
import { createSync } from './src/sync';
import { styles } from './src/theme';
import { Button } from './src/ui';

function WorkoutLog({ base }: { base: string }) {
  const database = useRef<SQLiteDatabase | null>(null);
  const legacyStore = useRef<ReturnType<typeof createStore> | null>(null);
  const latestDraft = useRef<Draft | null>(null);
  const scopeToken = useRef<object>({});
  const messageToken = useRef<object>({});
  const [scopeGeneration, setScopeGeneration] = useState(0);
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
    scopeToken.current = {}; messageToken.current = {}; setScopeGeneration(value => value + 1);
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
    autoSync.current.request();
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
  const renderScope = scopeToken.current;
  const renderMessageToken = messageToken.current;
  const changeForScope = (value: Draft) => { if (scopeToken.current === renderScope) structuredChange(value); };
  const saveForScope = (value: Draft) => { if (scopeToken.current === renderScope) save(value); };
  const discardForScope = () => { if (scopeToken.current === renderScope) discard(); };
  const removeForScope = () => { if (scopeToken.current === renderScope) remove(); };
  const openForScope = (workout: Workout) => { if (scopeToken.current === renderScope) open(workout); };
  const structuredForScope = () => { if (scopeToken.current === renderScope) openStructured(); };
  const messageHandlers = createChatMessageHandlers({
    current: () => latestDraft.current,
    isCurrent: () => scopeToken.current === renderScope && messageToken.current === renderMessageToken,
    setCurrent: value => { latestDraft.current = value; },
    createDraft: () => newDraft(randomUUID()),
    writeDraft: value => { (store.current ?? legacyStore.current)!.writeDraft(value); },
    saveDraft: value => { const target = store.current ?? legacyStore.current; if (!target) throw new Error('storage unavailable'); target.save(value); },
    onIssue: setError,
    onSaveFailure: () => setError(t.chatSaveFailed),
    onSaved: () => {
      messageToken.current = {};
      setError(null); setDraft(null); setDraftSaved(true); reload();
      if (store.current) autoSync.current.request();
    },
  });
  function currentDraft() { return latestDraft.current; }
  function retryMessageDraft() {
    const pending = latestDraft.current;
    if (!pending || scopeToken.current !== renderScope || messageToken.current !== renderMessageToken) return false;
    try { (store.current ?? legacyStore.current)!.writeDraft(pending); return true; }
    catch { return false; }
  }
  function openStructured() {
    let activeDraft = currentDraft();
    messageToken.current = {};
    if (activeDraft?.messageText) {
      const parsed = applyWorkoutMessage(activeDraft.messageText, activeDraft);
      if (parsed.ok) {
        activeDraft = parsed.draft; latestDraft.current = activeDraft;
        try { (store.current ?? legacyStore.current)!.writeDraft(activeDraft); } catch { setDraftSaved(false); }
      }
    }
    if (activeDraft) { setDraft(activeDraft); setEditing(true); return; }
    change(newDraft(randomUUID())); setEditing(true);
  }
  function structuredChange(next: Draft) {
    const structured = { ...next };
    delete structured.messageText;
    change(structured);
  }
  function open(workout?: Workout) {
    const activeDraft = currentDraft();
    if (activeDraft) {
      if (workout) Alert.alert(t.draftTitle, t.draftHint, [{ text: t.cancel, style: 'cancel' }]);
      else { setDraft(activeDraft); setEditing(true); }
      return;
    }
    messageToken.current = {};
    change(workout ? toDraft(workout) : newDraft(randomUUID())); setEditing(true);
  }
  function save(currentDraft: Draft) {
    const issue = validateDraft(currentDraft);
    if (issue) { setError(validationText(issue)); return; }
    try {
      (store.current ?? legacyStore.current)!.save(currentDraft); messageToken.current = {}; reload(); setDraft(null); latestDraft.current = null; setEditing(false); setDraftSaved(true); setError(null); if (store.current) autoSync.current.request();
    } catch { setError(t.saveFailed); }
  }
  function discard() {
    const scoped = store.current ?? legacyStore.current;
    const token = scopeToken.current;
    Alert.alert(t.discardTitle, t.discardBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.discard, style: 'destructive', onPress: () => {
        if (scopeToken.current !== token || (store.current ?? legacyStore.current) !== scoped || !scoped) return;
        try { messageToken.current = {}; scoped.clearDraft(); latestDraft.current = null; setDraft(null); setEditing(false); setDraftSaved(true); setError(null); }
        catch { setError(t.discardFailed); }
      } },
    ]);
  }
  function remove() {
    const activeDraft = currentDraft();
    const scoped = store.current ?? legacyStore.current;
    const token = scopeToken.current;
    if (!activeDraft || !scoped) return;
    const id = activeDraft.id;
    Alert.alert(t.deleteTitle, t.deleteBody, [
      { text: t.cancel, style: 'cancel' },
      { text: t.delete, style: 'destructive', onPress: () => {
        if (scopeToken.current !== token || (store.current ?? legacyStore.current) !== scoped) return;
        try { messageToken.current = {}; scoped.remove(id); reload(); setDraft(null); latestDraft.current = null; setEditing(false); setDraftSaved(true); setError(null); if (store.current) autoSync.current.request(); }
        catch { setError(t.deleteFailed); }
      } },
    ]);
  }
  function importLegacy() {
    const scoped = store.current;
    const token = scopeToken.current;
    if (!session || !scoped) return;
    Alert.alert(t.importTitle, t.importBody(session.userId, base), [{ text: t.cancel, style: 'cancel' }, { text: t.import, onPress: () => {
      if (store.current !== scoped || scopeToken.current !== token) return;
      try { scoped.importLegacy(randomUUID); messageToken.current = {}; setScopeGeneration(value => value + 1); const importedDraft = scoped.load().draft; latestDraft.current = importedDraft; setDraft(importedDraft); reload(); autoSync.current.request(); }
      catch { setError(t.importFailed); }
    } }]);
  }
  function resolve(id: string) {
    const scoped = store.current;
    const token = scopeToken.current;
    Alert.alert(t.conflictTitle, t.conflictBody, [{ text: t.cancel, style: 'cancel' }, { text: t.conflictAction, style: 'destructive', onPress: () => {
      if (store.current !== scoped || scopeToken.current !== token) return;
      const activeBeforeResolution = latestDraft.current;
      void sync.resolve(id).then(() => { if (store.current === scoped && scoped && alive.current && scopeToken.current === token) {
        const next = scoped.load().draft;
        if (activeBeforeResolution?.id === id) { messageToken.current = {}; setScopeGeneration(value => value + 1); }
        latestDraft.current = next; setDraft(next);
      } });
    } }]);
  }
  const draftStatus = <View style={styles.field}>
    <Text style={draftSaved ? styles.muted : styles.error} accessibilityLiveRegion="polite">{draftSaved ? t.draftSaved : t.draftFailed}</Text>
    {!draftSaved && draft && <Button label={t.retry} secondary onPress={() => { if (scopeToken.current === renderScope && latestDraft.current) change(latestDraft.current); }} />}
  </View>;
  const authControls = <View style={styles.field}>
    {session && <><Text style={styles.muted}>{t.account(session.userId)}</Text><Button label={t.logout} secondary onPress={() => { if (scopeToken.current === renderScope) void logout(); }} /></>}
    {(!session || syncError === 'unauthorized') && !login && <Button label={t.login} onPress={() => { if (scopeToken.current === renderScope) void signIn(); }} />}
    {login && <><Text style={styles.muted}>{t.loginWaiting}</Text><Button label={t.openTelegram} onPress={() => { if (scopeToken.current === renderScope) void Linking.openURL(login.bot_url).catch(() => setSyncError('request_failed')); }} /><Button label={t.cancel} secondary onPress={() => { if (scopeToken.current === renderScope) void cancelLogin(); }} /></>}
    {syncError && <Text style={styles.error} accessibilityRole="alert">{t.errors[syncError]}</Text>}
  </View>;
  if (phase !== 'ready') return <View style={styles.center}>
    <Text style={styles.heading}>{t.appTitle}</Text><Text style={phase === 'failed' ? styles.error : styles.muted}>{phase === 'failed' ? t.loadFailed : t.loading}</Text>
    {phase === 'failed' && <Button label={t.retry} onPress={() => { void load(); }} />}
  </View>;
  if (programMenu && programStore.current) return <View style={styles.flex}>
    {syncError && <Text style={styles.error}>{t.errors[syncError]}</Text>}
    <Programs key={accountKey(session!)} store={programStore.current} onBack={() => { if (scopeToken.current === renderScope) setProgramMenu(false); }} onMutation={() => { if (scopeToken.current === renderScope) { reload(); autoSync.current.request(); } }} onResolve={id => scopeToken.current === renderScope ? sync.resolveProgram(id).then(() => { reload(); }) : Promise.resolve()} />
  </View>;
  const activeDraft = currentDraft();
  if (editing && activeDraft) return <Editor draft={activeDraft} history={workouts} programs={programs} onChange={changeForScope} onSave={saveForScope} onDiscard={discardForScope}
    onDelete={workouts.some(workout => workout.id === activeDraft.id) ? removeForScope : undefined} error={error} status={draftStatus}
    onBack={() => { if (scopeToken.current === renderScope) { setDraft(currentDraft()); setEditing(false); setError(null); } }} />;
  const scopeKey = `${session ? accountKey(session) : 'guest'}:${scopeGeneration}`;
  return <ChatScreen key={scopeKey} workouts={workouts} programs={programs} pending={rows.filter(row => row.pending).length} draft={activeDraft}
    statusForWorkout={id => { const row = rows.find(value => value.workout.id === id); return !session ? t.statusLocal : !row ? t.statusLocal : row.error ? t.statusConflict : row.pending ? t.statusPending : t.statusSynced; }}
    error={error} status={draftStatus} onDraftText={messageHandlers.onText} onRetryDraft={retryMessageDraft} onSend={messageHandlers.onSend} onEdit={openForScope}
    onStructured={structuredForScope}
    account={<>{session && <Button label={t.programs} secondary onPress={() => { if (scopeToken.current === renderScope) setProgramMenu(true); }} />}{authControls}{!session && <Text style={styles.muted}>{t.signedOut}</Text>}{session && rows.filter(row => row.error).map(row => <View key={row.workout.id} style={styles.field}><Text style={styles.error}>{t.errors[row.error as ErrorCode] ?? t.errors.request_failed}</Text><Button label={t.conflictAction} onPress={() => { if (scopeToken.current === renderScope) resolve(row.workout.id); }} /></View>)}{session && legacy && <Button label={t.import} secondary onPress={() => { if (scopeToken.current === renderScope) importLegacy(); }} />}</>} />;
}
export default function App() {
  let base: string | null = null;
  try { base = apiURL(process.env.EXPO_PUBLIC_API_URL); } catch { /* Configuration is required, not a runtime fallback. */ }
  return <SafeAreaProvider><SafeAreaView style={styles.screen}><StatusBar style="light" />
    {base ? <WorkoutLog base={base} /> : <View style={styles.center}><Text style={styles.error}>{t.errors.configuration}</Text></View>}
  </SafeAreaView></SafeAreaProvider>;
}
