import { useState } from 'react';
import { existingSelection, exercisePreview, invalidExerciseId, toggleExercise } from './exerciseList';
import { randomUUID } from 'expo-crypto';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH, renameDraft } from './model';
import type { Draft, DraftExercise, DraftSet, Workout } from './model';
import { t } from './i18n';
import { colors, styles, TOUCH_TARGET } from './theme';
import { Button, Card, Field } from './ui';

import { acceptReps, exerciseSets, loadProgramExercises, matchingProgram, normalizeName, plannedSets, previousWeights, weightHint } from './programs';
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
  onSave: () => void;
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
  const program = matchingProgram(draft, programs);
  const selection = existingSelection(selectedId, draft.exercises);
  function save() {
    const invalidId = invalidExerciseId(draft);
    if (invalidId) setSelectedId(invalidId);
    onSave();
  }
  function updateExercise(id: string, update: Partial<DraftExercise>) {
    onChange({ ...draft, exercises: draft.exercises.map(entry => entry.id === id ? { ...entry, ...update } : entry) });
  }
  function updateSet(entry: DraftExercise, id: string, update: Partial<DraftSet>) {
    updateExercise(entry.id, { sets: entry.sets.map(set => set.id === id ? { ...set, ...update } : set) });
  }
  function addExercise() {
    const id = randomUUID();
    setSelectedId(id);
    onChange({ ...draft, exercises: [...draft.exercises, {
      id, name: '', sets: plannedSets(1, randomUUID),
    }] });
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
        <Field label={t.date} value={draft.date} onChangeText={date => onChange({ ...draft, date })}
          placeholder={t.datePlaceholder} maxLength={DATE_INPUT_LENGTH} autoCorrect={false} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
        <View style={styles.workoutNameRow}>
          <View style={styles.workoutNameColumn}>
            <Field label={t.optionalLabel(t.title)} value={draft.title} onChangeText={title => onChange(renameDraft(draft, title))}
              placeholder={t.titlePlaceholder} maxLength={MAX_TEXT_LENGTH} />
          </View>
          <View style={styles.workoutNameColumn}>
            <Button label={t.loadExercises} disabled={!program} onPress={() => onChange(loadProgramExercises(draft, programs, randomUUID))} />
          </View>
        </View>
        <Field label={t.optionalLabel(t.notes)} value={draft.notes} onChangeText={notes => onChange({ ...draft, notes })}
          placeholder={t.notesPlaceholder} maxLength={MAX_TEXT_LENGTH} multiline />
      </Card>
      <View style={styles.field}>
        <Text style={styles.heading}>{t.exercises}</Text>
        <Text style={styles.muted}>{t.weightHint}</Text>
      </View>
      <View style={styles.exerciseList}>
        {draft.exercises.map((entry, exerciseIndex) => {
          const target = program?.entries.find(e => normalizeName(e.name) === normalizeName(entry.name));
          const weights = previousWeights(draft, entry, history);
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
                    onChange({ ...draft, exercises: draft.exercises.filter(exercise => exercise.id !== entry.id) });
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
                <TextInput style={[styles.input, styles.setInput]} value={set.kg} onChangeText={kg => updateSet(displayed, set.id, { kg })}
                  placeholder={weightHint(weights, setIndex)} placeholderTextColor={colors.muted} keyboardType="decimal-pad" accessibilityLabel={t.kgLabel(exerciseIndex, setIndex)} maxLength={WEIGHT_INPUT_LENGTH} selectTextOnFocus />
                <TextInput style={[styles.input, styles.setInput]} value={set.reps} onChangeText={reps => updateSet(displayed, set.id, acceptReps(set, reps, weightHint(weights, setIndex)))}
                  placeholder={target?.target_reps == null ? '' : String(target.target_reps)} placeholderTextColor={colors.muted} keyboardType="number-pad" accessibilityLabel={t.repsLabel(exerciseIndex, setIndex)} maxLength={REPS_INPUT_LENGTH} selectTextOnFocus />
                <Pressable style={styles.removeButton} accessibilityRole="button" accessibilityLabel={t.removeSet(exerciseIndex, setIndex)}
                  onPress={() => updateExercise(entry.id, { sets: shownSets.filter(value => value.id !== set.id) })}>
                  <Text style={styles.removeText}>{t.removeGlyph}</Text>
                </Pressable>
              </View>)}
              <Button label={t.addSet} secondary onPress={() => {
                updateExercise(entry.id, { sets: [...shownSets, ...plannedSets(1, randomUUID)] });
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
