import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const root = process.cwd();
const editorPath = join(root, 'src/Editor.tsx');
const base = 'e16f18235b94afd41b9756a5094a2badd7d723f5';

test('actual Editor input and Save callbacks from one render submit the latest edit', () => {
  const currentSource = readFileSync(editorPath, 'utf8');
  let baseSource: string | null = null;
  try { baseSource = execFileSync('git', ['show', `${base}:mobile/src/Editor.tsx`], { cwd: root, encoding: 'utf8' }); }
  catch { /* Private source snapshots need not include Git history; current production handler is still exercised below. */ }
  const originalDraft = {
    id: 'draft', date: '2026-10-11', title: 'Push', notes: '', exercises: [],
  };

  function runEditor(source: string) {
    let submitted: { notes?: string } | undefined;
    let hookIndex = 0;
    const hooks: unknown[] = [];
    const elements = {
      jsx(type: unknown, props: Record<string, unknown> | null) { return { type, props: props ?? {} }; },
      jsxs(type: unknown, props: Record<string, unknown> | null) { return { type, props: props ?? {} }; },
      Fragment: 'Fragment',
    };
    const t = new Proxy({
      optionalLabel: (value: string) => `optional:${value}`,
      intake: () => '',
      exerciseRowLabel: () => 'exercise',
      unnamedExercise: () => 'exercise',
      exerciseNumber: () => 'exercise number',
      removeExercise: () => 'remove exercise',
      exerciseLabel: () => 'exercise name',
      position: () => 'set',
      kgLabel: () => 'weight',
      repsLabel: () => 'reps',
      removeSet: () => 'remove set',
    }, { get(target, key: string) { return target[key as keyof typeof target] ?? String(key); } });
    const stubs: Record<string, unknown> = {
      'react/jsx-runtime': elements,
      react: {
        useRef(initial: unknown) {
          const index = hookIndex++;
          hooks[index] ??= { current: initial };
          return hooks[index];
        },
        useState(initial: unknown) {
          const index = hookIndex++;
          hooks[index] ??= [initial, () => {}];
          return hooks[index];
        },
      },
      'react-native': { KeyboardAvoidingView: 'KAV', Platform: { OS: 'android' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
      'expo-crypto': { randomUUID: () => 'uuid' },
      './exerciseList': { existingSelection: () => null, exercisePreview: () => '', invalidExerciseId: () => null, toggleExercise: () => null },
      './model': { MAX_TEXT_LENGTH: 500, renameDraft: (draft: object, title: string) => ({ ...draft, title }) },
      './i18n': { t },
      './theme': { colors: {}, styles: new Proxy({}, { get: () => ({}) }), TOUCH_TARGET: 48 },
      './ui': { Button: 'Button', Card: 'Card', Field: 'Field' },
      './editorActions': { addDraftSet: (draft: unknown) => draft, removeDraftSet: (draft: unknown) => draft, updateDraftSet: (draft: unknown) => draft },
      './editorHistory': { createHistoryHintSelector: () => () => [] },
      './programs': {
        acceptReps: (set: unknown) => set, exerciseSets: (entry: { sets: unknown[] }) => entry.sets,
        loadProgramExercises: (draft: unknown) => draft, matchingProgram: () => undefined,
        normalizeName: (name: string) => name, plannedSets: () => [], weightHint: () => '0',
      },
    };
    const js = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', js)((name: string) => {
      if (!(name in stubs)) throw new Error(`Unexpected Editor dependency: ${name}`);
      return stubs[name];
    }, module, module.exports);
    const editor = module.exports.Editor as (props: Record<string, unknown>) => { type: (props: Record<string, unknown>) => unknown; props: Record<string, unknown> };
    const props = { draft: structuredClone(originalDraft), history: [], programs: [], onChange: (_draft: unknown) => {}, onBack() {}, onSave(draft: { notes?: string }) { submitted = draft; }, onDiscard() {}, status: null, error: null };
    const session = editor(props);
    hookIndex = 0;
    const tree = session.type(session.props) as { type: unknown; props: Record<string, unknown> };
    const all: { type: unknown; props: Record<string, unknown> }[] = [];
    function visit(node: unknown) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      const element = node as { type?: unknown; props?: Record<string, unknown> };
      if (element.props) {
        all.push(element as { type: unknown; props: Record<string, unknown> });
        visit(element.props.children);
      }
    }
    visit(tree);
    const noteField = all.find(element => element.props.label === 'optional:notes');
    const saveButton = all.find(element => element.props.label === 'save');
    assert.ok(noteField && saveButton, 'rendered production notes and Save handlers are available');
    (noteField.props.onChangeText as (value: string) => void)('typed immediately before save');
    // Invoke the Save callback from the same rendered tree; deliberately do not render between events.
    (saveButton.props.onPress as () => void)();
    return submitted;
  }

  if (baseSource !== null) {
    const baseSubmitted = runEditor(baseSource);
    assert.equal(baseSubmitted?.notes, undefined, 'base Editor invokes Save without the latest draft');
    assert.throws(() => assert.equal(baseSubmitted?.notes, 'typed immediately before save'), /typed immediately before save/,
      'the edit-then-save contract assertion fails against the original production Editor');
  }
  assert.equal(runEditor(currentSource)?.notes, 'typed immediately before save');
});
