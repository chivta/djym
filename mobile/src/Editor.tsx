import { randomUUID } from 'expo-crypto';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH, WORKOUT_TYPES } from './model';
import type { Draft, DraftExercise, DraftSet } from './model';
import { t } from './i18n';
import { colors, styles, TOUCH_TARGET } from './theme';
import { Button, Card, Field } from './ui';

const WEIGHT_INPUT_LENGTH = 7;
const REPS_INPUT_LENGTH = 4;
const DATE_INPUT_LENGTH = 10;
const EMPTY_WEIGHT = '0';

export function Editor({ draft, onChange, onBack, onSave, onDiscard, onDelete, status, error }: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  onBack: () => void;
  onSave: () => void;
  onDiscard: () => void;
  onDelete?: () => void;
  status: React.ReactNode;
  error: string | null;
}) {
  function updateExercise(id: string, update: Partial<DraftExercise>) {
    onChange({ ...draft, exercises: draft.exercises.map(entry => entry.id === id ? { ...entry, ...update } : entry) });
  }
  function updateSet(entry: DraftExercise, id: string, update: Partial<DraftSet>) {
    updateExercise(entry.id, { sets: entry.sets.map(set => set.id === id ? { ...set, ...update } : set) });
  }
  function addExercise() {
    onChange({ ...draft, exercises: [...draft.exercises, {
      id: randomUUID(), name: '', sets: [{ id: randomUUID(), kg: EMPTY_WEIGHT, reps: '' }],
    }] });
  }
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.header}>
      <View style={styles.between}>
        <Button label={t.back} onPress={onBack} secondary />
        <Text style={styles.title}>{t.editorTitle}</Text>
      </View>
      {status}
    </View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Card>
        <Field label={t.date} value={draft.date} onChangeText={date => onChange({ ...draft, date })}
          placeholder={t.datePlaceholder} maxLength={DATE_INPUT_LENGTH} autoCorrect={false} autoCapitalize="none" keyboardType="numbers-and-punctuation" />
        <Text style={styles.muted}>{t.optionalLabel(t.title)}</Text>
        <View style={styles.field}>
          <Button label={draft.title ? t.noType : `✓ ${t.noType}`} secondary onPress={() => onChange({ ...draft, title: '' })} />
          {WORKOUT_TYPES.map(type => <Button key={type} label={`${draft.title === type ? '✓ ' : ''}${t.types[type]}`} secondary onPress={() => onChange({ ...draft, title: type })} />)}
        </View>
        <Field label={t.optionalLabel(t.notes)} value={draft.notes} onChangeText={notes => onChange({ ...draft, notes })}
          placeholder={t.notesPlaceholder} maxLength={MAX_TEXT_LENGTH} multiline />
      </Card>
      <View style={styles.field}>
        <Text style={styles.heading}>{t.exercises}</Text>
        <Text style={styles.muted}>{t.weightHint}</Text>
      </View>
      {draft.exercises.map((entry, exerciseIndex) => <Card key={entry.id}>
        <View style={styles.between}>
          <Text style={styles.eyebrow}>{t.exerciseNumber(exerciseIndex)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t.removeExercise(exerciseIndex)} style={styles.removeButton}
            onPress={() => onChange({ ...draft, exercises: draft.exercises.filter(exercise => exercise.id !== entry.id) })}>
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
        {entry.sets.map((set, setIndex) => <View key={set.id} style={styles.row}>
          <Text style={styles.setNumber}>{t.position(setIndex)}</Text>
          <TextInput style={[styles.input, styles.setInput]} value={set.kg} onChangeText={kg => updateSet(entry, set.id, { kg })}
            keyboardType="decimal-pad" accessibilityLabel={t.kgLabel(exerciseIndex, setIndex)} maxLength={WEIGHT_INPUT_LENGTH} selectTextOnFocus />
          <TextInput style={[styles.input, styles.setInput]} value={set.reps} onChangeText={reps => updateSet(entry, set.id, { reps })}
            keyboardType="number-pad" accessibilityLabel={t.repsLabel(exerciseIndex, setIndex)} maxLength={REPS_INPUT_LENGTH} selectTextOnFocus />
          <Pressable style={styles.removeButton} accessibilityRole="button" accessibilityLabel={t.removeSet(exerciseIndex, setIndex)}
            onPress={() => updateExercise(entry.id, { sets: entry.sets.filter(value => value.id !== set.id) })}>
            <Text style={styles.removeText}>{t.removeGlyph}</Text>
          </Pressable>
        </View>)}
        <Button label={t.addSet} secondary onPress={() => {
          const last = entry.sets[entry.sets.length - 1];
          updateExercise(entry.id, { sets: [...entry.sets, { id: randomUUID(), kg: last?.kg ?? EMPTY_WEIGHT, reps: last?.reps ?? '' }] });
        }} />
      </Card>)}
      <Button label={t.addExercise} secondary onPress={addExercise} />
      {error && <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}
      <Button label={t.save} onPress={onSave} />
      <Button label={t.discard} onPress={onDiscard} secondary />
      {onDelete && <Button label={t.delete} onPress={onDelete} secondary danger />}
    </ScrollView>
  </KeyboardAvoidingView>;
}
