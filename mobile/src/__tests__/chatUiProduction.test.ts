import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { createAccountStore, accountKey } from '../accountStore.ts';
import { createProgramStore } from '../programStore.ts';
import { createStore } from '../storage.ts';
import { MAX_TEXT_LENGTH, newDraft, toDraft } from '../model.ts';
import { createChatMessageHandlers, insertAtSelection, sendOnce } from '../chatInput.ts';
import { applyWorkoutMessage, formatWorkoutMessage } from '../workoutMessage.ts';
import { buildHistorySuggestionIndex } from '../messageSuggestions.ts';
import { t, validationText } from '../i18n.ts';
const styles = new Proxy({}, { get: (_target, key) => String(key) });
const colors = { border: '#303a49', muted: '#98a5b8' };

const root = process.cwd();
const jsxRuntime = { jsx: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } }), jsxs: (type: unknown, props: Record<string, unknown> | null, key?: unknown) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } }), Fragment: 'Fragment' };
function hookRuntime() {
  let index = 0;
  const hooks: unknown[] = [];
  const effects: (() => void | (() => void))[] = [];
  return {
    reset() { index = 0; },
    clear() { index = 0; hooks.length = 0; effects.length = 0; },
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    react: {
      useRef(initial: unknown) { const i = index++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i] as { current: unknown }; },
      useState(initial: unknown) { const i = index++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], (next: unknown) => { hooks[i] = typeof next === 'function' ? (next as (value: unknown) => unknown)(hooks[i]) : next; }] as const; },
      useEffect(effect: () => void | (() => void), deps?: unknown[]) { const i = index++; const prior = hooks[i] as unknown[] | undefined; if (!deps || !prior || deps.some((value, n) => !Object.is(value, prior[n]))) { hooks[i] = deps ?? []; effects.push(effect); } },
      useCallback(callback: unknown) { index++; return callback; },
      useMemo(factory: () => unknown) { index++; return factory(); },
      memo(component: unknown) { return component; },
    },
  };
}
function dbAdapter(sqlite: DatabaseSync, counts?: { reads: number }) {
  return {
    execSync(sql: string) { sqlite.exec(sql); },
    runSync(sql: string, ...params: (string | number)[]) { sqlite.prepare(sql).run(...params); },
    getFirstSync<T>(sql: string, ...params: (string | number)[]): T | null { if (counts && /^\s*SELECT/i.test(sql)) counts.reads++; return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null; },
    getAllSync<T>(sql: string, ...params: (string | number)[]): T[] { if (counts && /^\s*SELECT/i.test(sql)) counts.reads++; return sqlite.prepare(sql).all(...params) as T[]; },
    withTransactionSync(action: () => void) { sqlite.exec('BEGIN'); try { action(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
}
function transpile(path: string, append = '') {
  return ts.transpileModule(readFileSync(path, 'utf8') + append, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
}
function loadChatScreen(runtime: ReturnType<typeof hookRuntime>) {
  const js = transpile(join(root, 'src/ChatScreen.tsx'));
  const module = { exports: {} as Record<string, any> };
  const stubs: Record<string, unknown> = {
    react: runtime.react, 'react/jsx-runtime': jsxRuntime, 'expo-crypto': { randomUUID: () => 'chat-id' },
    'react-native': { ...Boundaries, Platform: { OS: 'android' } }, './model': { MAX_TEXT_LENGTH }, './programs': {}, './workoutMessage': { applyWorkoutMessage, formatWorkoutMessage },
    './messageSuggestions': { buildHistorySuggestionIndex }, './ui': { Button: 'Button', Card: 'Card' }, './theme': { styles, colors }, './i18n': { t },
    './chatInput': { insertAtSelection, sendOnce },
  };
  new Function('require', 'module', 'exports', js)((name: string) => { if (!(name in stubs)) throw new Error(`Unexpected ChatScreen dependency ${name}`); return stubs[name]; }, module, module.exports);
  return module.exports.ChatScreen as (props: Record<string, any>) => unknown;
}
function visit(node: unknown, out: { type: unknown; props: Record<string, any> }[] = []) {
  if (Array.isArray(node)) { for (const child of node) visit(child, out); return out; }
  if (!node || typeof node !== 'object') return out;
  const entry = node as { type?: unknown; props?: Record<string, any> };
  if (entry.props) { out.push(entry as { type: unknown; props: Record<string, any> }); visit(entry.props.children, out); }
  return out;
}
const Boundaries = { Button: 'Button', Card: 'Card', Programs: 'Programs', Editor: 'Editor', FlatList: 'FlatList', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', KeyboardAvoidingView: 'KeyboardAvoidingView', ScrollView: 'ScrollView' };

type QaSession = { apiURL: string; userId: number; token: string; expiresAt: string };
type HarnessOptions = { session?: QaSession | null; nextSession?: QaSession | null };
function appHarness(options: HarnessOptions = {}, existingDb?: DatabaseSync) {
  const sqlite = existingDb ?? new DatabaseSync(':memory:');
  const counts = { reads: 0 };
  const db = dbAdapter(sqlite, counts);
  const legacy = createStore(db);
  const runtime = hookRuntime();
  const chatRuntime = hookRuntime();
  const ChatScreen = loadChatScreen(chatRuntime);
  const alerts: { title: string; message: string; buttons: any[] }[] = [];
  const auto = { requests: 0, generations: [] as (string | number | null)[], callback: null as null | ((generation: string | number) => Promise<unknown>) };
  const sync = { runs: 0, onChange: null as null | (() => void), onError: null as null | ((code: string | null) => void) };
  let polledSession: QaSession | null = options.nextSession ?? null;
  let uuid = 0;
  const subscriptions = { remove() {} };
  const stubs: Record<string, unknown> = {
    react: runtime.react,
    'react/jsx-runtime': jsxRuntime,
    'expo-crypto': { randomUUID: () => `qa-${++uuid}` },
    'expo-secure-store': { getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-sqlite': { openDatabaseSync: () => db },
    'expo-network': { getNetworkStateAsync: async () => ({ isConnected: false, isInternetReachable: false }), addNetworkStateListener: () => subscriptions },
    'react-native': {
      Alert: { alert(title: string, message: string, buttons: any[]) { alerts.push({ title, message, buttons }); } },
      AppState: { currentState: 'active', addEventListener: () => subscriptions }, BackHandler: { addEventListener: () => subscriptions },
      Linking: { openURL: async () => {} }, ...Boundaries,
    },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    './src/Programs': { Programs: 'Programs' }, './src/programStore': { createProgramStore },
    './src/Editor': { Editor: 'Editor' }, './src/ChatScreen': { ChatScreen },
    './src/chatInput': { createChatMessageHandlers }, './src/workoutMessage': { applyWorkoutMessage },
    './src/autoSync': { createAutoSync: (config: { run(generation: string | number): Promise<unknown> }) => { auto.callback = config.run; return {
      setAccountGeneration(value: string | number | null) { auto.generations.push(value); }, setAppActive() {}, setConnectivity() {}, dispose() {},
      request() { auto.requests++; if (auto.generations.at(-1) !== null) void config.run(auto.generations.at(-1)!); },
    }; } },
    './src/i18n': { t, validationText }, './src/model': { newDraft, toDraft, validateDraft: (draft: any) => draft.exercises.length ? null : { code: 'exercises' }, setCount: (workout: any) => workout.exercises.reduce((n: number, e: any) => n + e.sets.length, 0) },
    './src/storage': { createStore, DATABASE_NAME: 'qa.db' }, './src/accountStore': { accountKey, createAccountStore },
    './src/api': { apiURL: () => 'https://qa.invalid/api', ApiError: class ApiError extends Error { code = 'request_failed'; }, createApi: () => ({}) },
    './src/auth': { createAuth: () => ({ restore: async () => ({ session: options.session ?? null, login: null }), start: async () => ({ bot_url: 'https://t.me/fake' }), poll: async () => { const value = polledSession; polledSession = null; return value; }, cancel: async () => {}, logout: async () => {} }) },
    './src/sync': { createSync: (onChange: () => void, onError: (code: string | null) => void) => { sync.onChange = onChange; sync.onError = onError; return {
      activate() {}, async run() { sync.runs++; }, resolve: async () => {}, resolveProgram: async () => {},
    }; } },
    './src/theme': { styles, colors }, './src/ui': { Button: 'Button', Card: 'Card' },
  };
  const js = transpile(join(root, 'App.tsx'), '\nexports.WorkoutLog = WorkoutLog;');
  const module = { exports: {} as Record<string, any> };
  new Function('require', 'module', 'exports', 'setInterval', 'clearInterval', js)((name: string) => {
    if (!(name in stubs)) throw new Error(`Unexpected App dependency ${name}`);
    return stubs[name];
  }, module, module.exports, () => 1, () => {});
  let renders = 0;
  function renderApp() { runtime.reset(); renders++; const tree = module.exports.WorkoutLog({ base: 'https://qa.invalid/api' }); runtime.flushEffects(); return tree; }
  function currentScreen(tree = renderApp()) { return visit(tree).find(node => node.type === ChatScreen)!; }
  let chatKey: unknown;
  function renderChat(screen = currentScreen()) {
    const nextKey = screen.props.key;
    if (nextKey !== chatKey) { chatKey = nextKey; chatRuntime.clear(); }
    chatRuntime.reset();
    return ChatScreen(screen.props);
  }
  renderApp();
  return { sqlite, db, legacy, alerts, auto, sync, counts, ChatScreen, renderApp, currentScreen, renderChat, get renders() { return renders; }, setNextSession(value: HarnessOptions['nextSession']) { polledSession = value ?? null; }, dispose() { sqlite.close(); } };
}

const chatRuntimeStandalone = hookRuntime();
const StandaloneChatScreen = loadChatScreen(chatRuntimeStandalone);
function savedFixture(harness: ReturnType<typeof appHarness>, id = 'saved') {
  const draft = { ...newDraft(id), title: 'Upper', exercises: [{ id: 'e', name: 'Bench', sets: [{ id: 's', kg: '60', reps: '8' }] }] };
  return harness.legacy.save(draft);
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('production App owner-scope regression checks: guest edit, pending raw draft, account isolation, and latest callbacks', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); savedFixture(h); await settle();
  const screen = h.currentScreen(); assert.equal(screen.props.onPrograms, undefined);
  let nodes = visit(h.renderChat(screen)); nodes.find(node => node.type === 'Button' && node.props.label === t.accountPanel)!.props.onPress();
  nodes = visit(h.renderChat(screen)); assert.equal(nodes.some(node => node.type === 'Button' && node.props.label === t.programs), false, 'guest Programs action is hidden');
  screen.props.onEdit(h.legacy.load().workouts[0]); assert.equal(visit(h.renderApp()).some(node => node.type === 'Editor'), true);
});

test('actual App preserves raw draft on opening another workout and across sync refresh', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); savedFixture(h); await settle();
  const screen = h.currentScreen(); assert.equal(screen.props.onDraftText('unfinished raw text'), true);
  h.sync.onChange!(); let refreshed = h.currentScreen(h.renderApp()); assert.equal(refreshed.props.draft.messageText, 'unfinished raw text');
  refreshed.props.onEdit(h.legacy.load().workouts[0]); assert.equal(h.legacy.load().draft?.messageText, 'unfinished raw text');
});

test('production App confines drafts to account A, guest, and account B and rejects callbacks retained across activation', async tcase => {
  const accountA = { apiURL: 'https://qa.invalid/api', userId: 101, token: 'A', expiresAt: '2099-01-01T00:00:00Z' };
  const accountB = { apiURL: 'https://qa.invalid/api', userId: 202, token: 'B', expiresAt: '2099-01-01T00:00:00Z' };
  const h = appHarness({ session: accountA, nextSession: accountB }); tcase.after(() => h.dispose()); await settle();
  const aScreen = h.currentScreen(); assert.equal(aScreen.props.onDraftText('A-only'), true);
  assert.equal(createAccountStore(h.db, accountKey(accountA)).load().draft?.messageText, 'A-only');
  let nodes = visit(h.renderChat(aScreen));
  nodes.find(node => node.type === 'Button' && node.props.label === t.accountPanel)!.props.onPress();
  let screen = h.currentScreen(h.renderApp()); nodes = visit(h.renderChat(screen));
  nodes.find(node => node.type === 'Button' && node.props.label === t.logout)!.props.onPress(); await settle();
  screen = h.currentScreen(h.renderApp()); const guestDraft = screen.props.onDraftText as (text: string) => boolean;
  assert.equal(guestDraft('guest-only'), true); assert.equal(h.legacy.load().draft?.messageText, 'guest-only');
  assert.equal(aScreen.props.onDraftText('stale A'), false);
  nodes = visit(h.renderChat(screen)); nodes.find(node => node.type === 'Button' && node.props.label === t.accountPanel)!.props.onPress();
  screen = h.currentScreen(h.renderApp()); nodes = visit(h.renderChat(screen)); nodes.find(node => node.type === 'Button' && node.props.label === t.login)!.props.onPress(); await settle();
  h.renderApp(); await settle(); screen = h.currentScreen(h.renderApp());
  assert.equal(screen.props.onDraftText('B-only'), true); assert.equal(createAccountStore(h.db, accountKey(accountB)).load().draft?.messageText, 'B-only');
  assert.equal(h.legacy.load().draft?.messageText, 'guest-only'); assert.equal(guestDraft('stale guest'), false);
});

test('explicit guest import preserves local history and schedules account synchronization', async tcase => {
  const session = { apiURL: 'https://qa.invalid/api', userId: 505, token: 'E', expiresAt: '2099-01-01T00:00:00Z' };
  const h = appHarness({ session }); tcase.after(() => h.dispose()); savedFixture(h, 'guest-import'); await settle();
  const screen = h.currentScreen(); let nodes = visit(h.renderChat(screen));
  nodes.find(node => node.type === 'Button' && node.props.label === t.accountPanel)!.props.onPress();
  const accountScreen = h.currentScreen(h.renderApp()); nodes = visit(h.renderChat(accountScreen));
  const requestsBefore = h.auto.requests;
  nodes.find(node => node.type === 'Button' && node.props.label === t.import)!.props.onPress();
  h.alerts.at(-1)!.buttons.find(button => button.text === t.import).onPress();
  assert.equal(createAccountStore(h.db, accountKey(session)).load().workouts.length, 1);
  assert.equal(h.legacy.load().workouts.length, 0);
  assert.equal(h.auto.requests, requestsBefore + 1);
});

test('production App reports failed save and retains in-memory plus durable message', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); await settle();
  h.sqlite.exec("CREATE TRIGGER fail_guest_workout BEFORE INSERT ON workouts BEGIN SELECT RAISE(ABORT, 'disk_failure'); END;");
  const screen = h.currentScreen(); screen.props.onDraftText('Bench 60-8'); assert.equal(screen.props.onSend('Bench 60-8'), false);
  const refreshed = h.currentScreen(h.renderApp()); assert.equal(refreshed.props.error, t.chatSaveFailed); assert.equal(h.legacy.load().draft?.messageText, 'Bench 60-8');
});

test('guest edit, back, delete, discard, and invalid raw navigation/restart use the actual App callbacks', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); const saved = savedFixture(h); await settle();
  h.currentScreen().props.onEdit(saved); let editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  editor.props.onBack(); assert.ok(visit(h.renderApp()).some(node => node.type === h.ChatScreen));
  h.currentScreen().props.onStructured(); editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  editor.props.onDelete(); h.alerts.at(-1)!.buttons.find(button => button.text === t.delete).onPress(); assert.equal(h.legacy.load().workouts.length, 0);
  h.currentScreen().props.onStructured(); editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  editor.props.onDiscard(); h.alerts.at(-1)!.buttons.find(button => button.text === t.discard).onPress(); assert.equal(h.legacy.load().draft, null);
});

test('invalid raw drafts survive Programs, structured-editor back navigation, and account-store restart', async tcase => {
  const session = { apiURL: 'https://qa.invalid/api', userId: 404, token: 'D', expiresAt: '2099-01-01T00:00:00Z' };
  const h = appHarness({ session }); tcase.after(() => h.dispose()); await settle();
  let screen = h.currentScreen(); screen.props.onDraftText('bad raw syntax !');
  let chatNodes = visit(h.renderChat(screen)); chatNodes.find(node => node.type === 'Button' && node.props.label === t.accountPanel)!.props.onPress();
  screen = h.currentScreen(h.renderApp()); chatNodes = visit(h.renderChat(screen));
  chatNodes.find(node => node.type === 'Button' && node.props.label === t.programs)!.props.onPress();
  const programs = visit(h.renderApp()).find(node => node.type === 'Programs')!; const priorRequests = h.auto.requests;
  programs.props.onMutation(); assert.equal(h.auto.requests, priorRequests + 1); programs.props.onBack();
  screen = h.currentScreen(h.renderApp()); assert.equal(screen.props.draft.messageText, 'bad raw syntax !');
  screen.props.onStructured(); const editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  assert.equal(editor.props.draft.messageText, 'bad raw syntax !'); editor.props.onBack();
  screen = h.currentScreen(h.renderApp()); assert.equal(screen.props.draft.messageText, 'bad raw syntax !');
  const restarted = appHarness({ session }, h.sqlite); await settle(); assert.equal(restarted.currentScreen().props.draft.messageText, 'bad raw syntax !');
});

test('structured edits invalidate retained raw-message callbacks instead of restoring stale text', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); await settle();
  let screen = h.currentScreen(); assert.equal(screen.props.onDraftText('Bench 60-8'), true);
  const staleRawSend = screen.props.onSend as (text: string) => boolean;
  screen.props.onStructured();
  let editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  assert.equal(editor.props.draft.exercises[0].name, 'Bench');
  assert.equal(staleRawSend('Bench 60-8'), false);
  editor.props.onChange({ ...editor.props.draft, title: 'Changed in editor' });
  editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  assert.equal(editor.props.draft.messageText, undefined);
  editor.props.onBack();
  screen = h.currentScreen(h.renderApp()); assert.equal(screen.props.draft.messageText, undefined);
});

test('separate successful sends retain distinct IDs and all automatic sync requests stay scheduled', async tcase => {
  const session = { apiURL: 'https://qa.invalid/api', userId: 303, token: 'C', expiresAt: '2099-01-01T00:00:00Z' };
  const h = appHarness({ session }); tcase.after(() => h.dispose()); await settle(); let screen = h.currentScreen();
  screen.props.onDraftText('Bench 60-8'); assert.equal(screen.props.onSend('Bench 60-8'), true);
  const first = createAccountStore(h.db, accountKey(session)).load().workouts[0];
  screen = h.currentScreen(h.renderApp()); assert.equal(screen.props.statusForWorkout(first.id), t.statusPending);
  h.sqlite.prepare('UPDATE account_workouts SET pending = 0 WHERE account = ? AND id = ?').run(accountKey(session), first.id);
  h.sync.onChange!(); screen = h.currentScreen(h.renderApp()); assert.equal(screen.props.statusForWorkout(first.id), t.statusSynced);
  screen.props.onDraftText('Squat 80-5'); assert.equal(screen.props.onSend('Squat 80-5'), true);
  const workouts = createAccountStore(h.db, accountKey(session)).load().workouts; assert.equal(workouts.length, 2);
  assert.notEqual(workouts.find(workout => workout.exercises[0].name === 'Squat')?.id, first.id);
  const priorDeleteRequests = h.auto.requests; screen.props.onEdit(workouts[0]); const editor = visit(h.renderApp()).find(node => node.type === 'Editor')!;
  editor.props.onDelete(); h.alerts.at(-1)!.buttons.find(button => button.text === t.delete).onPress(); assert.equal(h.auto.requests, priorDeleteRequests + 1);
  assert.ok(h.auto.requests >= 4);
  assert.equal((readFileSync(join(root, 'App.tsx'), 'utf8').match(/sync\.run\(/g) ?? []).length, 1);
});

test('production ChatScreen keyboard props, selection suggestion, status refresh and two-send event contract', () => {
  const workout = { ...newDraft('history'), title: 'Upper', date: '2026-01-01', exercises: [{ id: 'e', name: 'Bench', sets: [{ id: 's', kg: 60, reps: 8 }] }] };
  const draft = { ...newDraft('edit'), title: 'Upper', date: '2026-01-02', messageText: 'Bench 6', exercises: [] };
  const delivery: { value: string } = { value: t.statusPending };
  let sends = 0;
  const props = { workouts: [workout], programs: [], pending: 1, draft, statusForWorkout: () => delivery.value, error: null, status: null,
    onDraftText: (text: string) => { draft.messageText = text; return true; }, onRetryDraft: () => true, onSend: () => { sends++; return true; }, onEdit() {}, onStructured() {}, account: null };
  chatRuntimeStandalone.reset(); let tree = StandaloneChatScreen(props); let nodes = visit(tree);
  const input = nodes.find(node => node.type === 'TextInput')!;
  assert.equal(input.props.multiline, true); assert.equal(input.props.maxLength, MAX_TEXT_LENGTH);
  input.props.onSelectionChange({ nativeEvent: { selection: { start: 6, end: 7 } } });
  assert.equal(nodes.find(node => node.type === 'FlatList')?.props.keyboardShouldPersistTaps, 'always');
  nodes.find(node => node.type === 'Button' && node.props.label === t.chatSuggestions)!.props.onPress();
  chatRuntimeStandalone.reset(); tree = StandaloneChatScreen(props); nodes = visit(tree);
  const suggestionList = nodes.find(node => node.type === 'FlatList' && node.props.horizontal)!;
  suggestionList.props.renderItem({ item: suggestionList.props.data[0] }).props.onPress(); assert.equal(draft.messageText, 'Bench Bench');
  const sendInput = nodes.find(node => node.type === 'TextInput')!; sendInput.props.onChangeText('Bench 60-8');
  const sendButton = nodes.find(node => node.type === 'Button' && node.props.label === t.chatSend)!;
  assert.equal(typeof sendButton.props.onPress, 'function'); sendButton.props.onPress(); sendButton.props.onPress(); assert.equal(sends, 1);
  delivery.value = t.statusSynced; props.statusForWorkout = () => delivery.value;
  chatRuntimeStandalone.reset(); tree = StandaloneChatScreen(props); nodes = visit(tree);
  const list = nodes.find(node => node.type === 'FlatList')!; const rowElement = list.props.renderItem({ item: workout });
  assert.ok(visit(rowElement.type(rowElement.props)).some(node => node.type === 'Text' && node.props.children === t.statusSynced));
});

test('actual App keystroke callbacks do not render App or read/sort history/database', async tcase => {
  const h = appHarness(); tcase.after(() => h.dispose()); await settle(); const screen = h.currentScreen();
  const priorRenders = h.renders; const priorReads = h.counts.reads;
  for (const value of ['B', 'Be', 'Bench 60-8']) assert.equal(screen.props.onDraftText(value), true);
  assert.equal(h.renders, priorRenders); assert.equal(h.counts.reads, priorReads);
  assert.equal(h.legacy.load().draft?.messageText, 'Bench 60-8');
});
