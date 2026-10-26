import { useRef, useState } from 'react';
import { addDraftSet, removeDraftSet, updateDraftSet } from './editorActions';
import { createHistoryHintSelector } from './editorHistory';
import { existingSelection, exercisePreview, invalidExerciseId, toggleExercise } from './exerciseList';
import { randomUUID } from 'expo-crypto';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH, renameDraft } from './model';
import type { Draft, DraftExercise, DraftSet, Workout } from './model';
import { t } from './i18n';
import { colors, styles, TOUCH_TARGET } from './theme';
import { Button, Card, Field } from './ui';

import { acceptReps, exerciseSets, loadProgramExercises, matchingProgram, normalizeName, plannedSets, weightHint } from './programs';
import type { Program } from './programs';

const WEIGHT_INPUT_LENGTH = 7;
const REPS_INPUT_LENGTH = 4;
const DATE_INPUT_LENGTH = 10;

type EditorProps = {
  draft: Draft;
  history: Workout[];
  programs: Program[];
  onChange: (draft: Draft) => void;
  onBack: () => void;
  onSave: (draft: Draft) => void;
  onDiscard: () => void;
  onDelete?: () => void;
  status: React.ReactNode;
  error: string | null;
};

export function Editor(props: EditorProps) {
  return <EditorSession key={props.draft.id} {...props} />;
}

function EditorSession({ draft, history, programs, onChange, onBack, onSave, onDiscard, onDelete, status, error }: EditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const selectHistoryHints = useRef(createHistoryHintSelector()).current;
  function change(update: (current: Draft) => Draft) {
    const next = update(latestDraft.current);
    latestDraft.current = next;
    onChange(next);
  }
  const program = matchingProgram(draft, programs);
  const selection = existingSelection(selectedId, draft.exercises);
  const selectedExercise = draft.exercises.find(entry => entry.id === selection);
  const selectedWeights = selectedExercise ? selectHistoryHints(draft, selectedExercise, history, selection) : [];
  function save() {
    const invalidId = invalidExerciseId(latestDraft.current);
    if (invalidId) setSelectedId(invalidId);
    onSave(latestDraft.current);
  }
  function updateExercise(id: string, update: Partial<DraftExercise>) {
    change(current => ({ ...current, exercises: current.exercises.map(entry => entry.id === id ? { ...entry, ...update } : entry) }));
  }
  function plannedCount(entry: DraftExercise) {
    return program?.entries.find(value => normalizeName(value.name) === normalizeName(entry.name))?.set_count ?? 0;
  }
  function updateSet(entry: DraftExercise, id: string, update: (set: DraftSet) => DraftSet) {
    change(current => updateDraftSet(current, entry.id, id, update, plannedCount));
  }
  function addExercise() {
    const id = randomUUID();
    setSelectedId(id);
    change(current => ({ ...current, exercises: [...current.exercises, {
      id, name: '', sets: plannedSets(1, randomUUID),
    }] }));
  }
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}>
      <View style={styles.between}>
        <Button label={t.back} onPress={onBack} secondary />
        <Text style={styles.title}>{t.editorTitle}</Text>
      </View>
      {!!t.intake(draft.kcal, draft.proteinG) && <Text style={styles.muted}>{t.intake(draft.kcal, draft.proteinG)}</Text>}
      {status}
    </View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Card>
        <Field label={t.date} value={draft.date} onChangeText={date => change(current => ({ ...current, date }))}
          placeholder={t.datePlaceholder} maxLength={DATE_INPUT_LENGTH} autoCorrect={false} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
        <View style={styles.workoutNameRow}>
          <View style={styles.workoutNameColumn}>
            <Field label={t.optionalLabel(t.title)} value={draft.title} onChangeText={title => change(current => renameDraft(current, title))}
              placeholder={t.titlePlaceholder} maxLength={MAX_TEXT_LENGTH} />
          </View>
          <View style={styles.workoutNameColumn}>
            <Button label={t.loadExercises} disabled={!program} onPress={() => change(current => loadProgramExercises(current, programs, randomUUID))} />
          </View>
        </View>
        <Field label={t.optionalLabel(t.notes)} value={draft.notes} onChangeText={notes => change(current => ({ ...current, notes }))}
          placeholder={t.notesPlaceholder} maxLength={MAX_TEXT_LENGTH} multiline />
      </Card>
      <View style={styles.field}>
        <Text style={styles.heading}>{t.exercises}</Text>
        <Text style={styles.muted}>{t.weightHint}</Text>
      </View>
      <View style={styles.exerciseList}>
        {draft.exercises.map((entry, exerciseIndex) => {
          const target = program?.entries.find(e => normalizeName(e.name) === normalizeName(entry.name));
          const weights = entry.id === selection ? selectedWeights : [];
          const shownSets = exerciseSets(entry, target?.set_count ?? 0);
          const displayed = { ...entry, sets: shownSets };
          const expanded = selection === entry.id;
          const name = entry.name.trim() || t.unnamedExercise(exerciseIndex);
          const preview = exercisePreview(entry.sets.filter(s => !s.planned || s.kg.trim() || s.reps.trim()), !!draft.remoteId);
          return <View key={entry.id} style={styles.exerciseRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={t.exerciseRowLabel(exerciseIndex, name, preview)}
              accessibilityState={{ expanded }} style={({ pressed }) => [styles.exerciseHeader, pressed && styles.pressed]}
              onPress={() => setSelectedId(toggleExercise(selection, entry.id))}>
              <Text style={styles.exerciseName} numberOfLines={2}>{name}</Text>
              <Text style={styles.exercisePreview} numberOfLines={2}>{preview}</Text>
              <Text style={styles.exerciseIndicator}>{expanded ? t.collapseExerciseGlyph : t.expandExerciseGlyph}</Text>
            </Pressable>
            {expanded && <View style={styles.exerciseDetails}>
              <View style={styles.between}>
                <Text style={styles.eyebrow}>{t.exerciseNumber(exerciseIndex)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t.removeExercise(exerciseIndex)} style={styles.removeButton}
                  onPress={() => {
                    setSelectedId(null);
                    change(current => ({ ...current, exercises: current.exercises.filter(exercise => exercise.id !== entry.id) }));
                  }}>
                  <Text style={styles.removeText}>{t.removeGlyph}</Text>
                </Pressable>
              </View>
              <TextInput style={styles.input} value={entry.name} onChangeText={name => updateExercise(entry.id, { name })}
                placeholder={t.exercisePlaceholder} placeholderTextColor={colors.muted} accessibilityLabel={t.exerciseLabel(exerciseIndex)} maxLength={MAX_TEXT_LENGTH} />
              <View style={styles.row}>
                <Text style={styles.setNumber}>{t.set}</Text>
                <Text style={styles.setLabel}>{t.kg}</Text>
                <Text style={styles.setLabel}>{t.reps}</Text>
                <View style={{ width: TOUCH_TARGET }} />
              </View>
              {shownSets.map((set, setIndex) => <View key={set.id} style={styles.row}>
                <Text style={styles.setNumber}>{t.position(setIndex)}</Text>
                <TextInput style={[styles.input, styles.setInput]} value={set.kg} onChangeText={kg => updateSet(displayed, set.id, current => ({ ...current, kg }))}
                  placeholder={weightHint(weights, setIndex)} placeholderTextColor={colors.muted} keyboardType="decimal-pad" accessibilityLabel={t.kgLabel(exerciseIndex, setIndex)} maxLength={WEIGHT_INPUT_LENGTH} selectTextOnFocus />
                <TextInput style={[styles.input, styles.setInput]} value={set.reps} onChangeText={reps => updateSet(displayed, set.id, current => acceptReps(current, reps, weightHint(weights, setIndex)))}
                  placeholder={target?.target_reps == null ? '' : String(target.target_reps)} placeholderTextColor={colors.muted} keyboardType="number-pad" accessibilityLabel={t.repsLabel(exerciseIndex, setIndex)} maxLength={REPS_INPUT_LENGTH} selectTextOnFocus />
                <Pressable style={styles.removeButton} accessibilityRole="button" accessibilityLabel={t.removeSet(exerciseIndex, setIndex)}
                  onPress={() => change(current => removeDraftSet(current, entry.id, set.id, plannedCount))}>
                  <Text style={styles.removeText}>{t.removeGlyph}</Text>
                </Pressable>
              </View>)}
              <Button label={t.addSet} secondary onPress={() => {
                change(current => addDraftSet(current, entry.id, plannedCount, randomUUID));
              }} />
            </View>}
          </View>;
        })}
        <Pressable accessibilityRole="button" accessibilityLabel={t.addExercise} onPress={addExercise}
          style={({ pressed }) => [styles.exerciseHeader, pressed && styles.pressed]}>
          <Text style={[styles.text, styles.flex]}>{t.addExercise}</Text>
          <Text style={styles.exerciseIndicator}>{t.addExerciseGlyph}</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      <Button label={t.save} onPress={save} />
      <Button label={t.discard} onPress={onDiscard} secondary />
      {onDelete && <Button label={t.delete} onPress={onDelete} secondary danger />}
    </ScrollView>
  </KeyboardAvoidingView>;
}
