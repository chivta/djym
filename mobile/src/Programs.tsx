import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { MAX_TEXT_LENGTH } from './model';
import { MAX_PROGRAM_EXERCISES, validateProgram } from './programs';
import type { Program } from './programs';
import type { ProgramStore } from './programStore';
import type { ErrorCode } from './api';
import { t } from './i18n';
import { Button, Card, Field } from './ui';
import { styles } from './theme';

export function Programs({ store, onBack, onMutation, onResolve }: { store: ProgramStore; onBack: () => void; onMutation: () => void; onResolve: (id: string) => Promise<void> }) {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [draft, setDraft] = useState<Program | null>(() => store.draft());
  const [error, setError] = useState<string | null>(null);
  function change(p: Program) {
    setDraft(p); setError(null);
    try { store.writeDraft(p); } catch { setError(t.programFailed); }
  }
  function discard() {
    Alert.alert(t.programDiscardTitle, t.programDiscardBody, [{ text: t.cancel, style: 'cancel' }, { text: t.discard, style: 'destructive', onPress: () => {
      if (!alive.current) return;
      try { store.clearDraft(); setDraft(null); setError(null); } catch { setError(t.programFailed); }
    } }]);
  }
  function remove(p: Program) {
    Alert.alert(t.programDeleteTitle, t.programDeleteBody, [{ text: t.cancel, style: 'cancel' }, { text: t.programDelete, style: 'destructive', onPress: () => {
      if (!alive.current) return;
      try { store.remove(p.id); if (draft?.id === p.id) setDraft(null); setError(null); onMutation(); } catch { setError(t.programFailed); }
    } }]);
  }
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.between}><Button label={t.back} secondary onPress={onBack} /><Text style={styles.title}>{t.programs}</Text></View>
    {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
    <Button label={t.refresh} secondary onPress={onMutation} />
    {error === t.programFailed && draft && <Button label={t.retry} secondary onPress={() => change(draft)} />}
    {draft ? <>
      <Field label={t.programName} value={draft.name} maxLength={MAX_TEXT_LENGTH} onChangeText={name => change({ ...draft, name })} />
      {draft.entries.map((entry, i) => {
        function update(patch: Partial<typeof entry>) { change({ ...draft!, entries: draft!.entries.map((e,j) => i === j ? { ...e, ...patch } : e) }); }
        function move(delta: number) {
          const entries = [...draft!.entries]; const j = i + delta;
          if (j < 0 || j >= entries.length) return;
          [entries[i], entries[j]] = [entries[j], entries[i]]; change({ ...draft!, entries });
        }
        return <Card key={i}>
          <Field label={t.exerciseLabel(i)} value={entry.name} maxLength={MAX_TEXT_LENGTH} onChangeText={name => update({ name })} />
          <Field label={t.setCount} value={entry.set_count ? String(entry.set_count) : ''} keyboardType="number-pad" maxLength={3} onChangeText={value => update({ set_count: /^\d+$/.test(value) ? Number(value) : 0 })} />
          <Field label={t.targetReps} value={entry.target_reps == null ? '' : String(entry.target_reps)} keyboardType="number-pad" maxLength={4} onChangeText={value => update({ target_reps: value === '' ? null : /^\d+$/.test(value) ? Number(value) : 0 })} />
          <Button label={t.moveUp} secondary onPress={() => move(-1)} />
          <Button label={t.moveDown} secondary onPress={() => move(1)} />
          <Button label={t.removeExercise(i)} secondary danger onPress={() => change({ ...draft, entries: draft.entries.filter((_,j) => i !== j) })} />
        </Card>;
      })}
      {draft.entries.length < MAX_PROGRAM_EXERCISES && <Button label={t.addExercise} secondary onPress={() => change({ ...draft, entries: [...draft.entries, { name: '', set_count: 3, target_reps: null }] })} />}
      <Button label={t.programSave} onPress={() => {
        if (validateProgram(draft)) { setError(t.programInvalid); return; }
        try { store.save(draft); setDraft(null); onMutation(); } catch { setError(t.programFailed); }
      }} />
      <Button label={t.discard} secondary onPress={discard} />
      {store.rows().some(r => r.program.id === draft.id) && <Button label={t.programDelete} secondary danger onPress={() => remove(draft)} />}
    </> : <Button label={t.newProgram} onPress={() => change({ id: randomUUID(), name: '', entries: [] })} />}
    {store.rows().map(row => <Card key={row.program.id}>
      <Text style={styles.title}>{row.program.name}</Text>
      {!row.deleted && <Text style={styles.muted}>{row.program.entries.map(e => `${e.name} · ${t.programEntryPreview(e.set_count, e.target_reps)}`).join('\n')}</Text>}
      {row.pending && <Text style={styles.muted}>{t.pending(1)}</Text>}
      {row.error && <><Text style={styles.error}>{t.errors[row.error as ErrorCode] ?? t.errors.request_failed}</Text><Button label={t.conflictAction} secondary onPress={() => {
        Alert.alert(t.conflictTitle, t.conflictBody, [{ text: t.cancel, style: 'cancel' }, { text: t.conflictAction, style: 'destructive', onPress: () => {
          if (!alive.current) return;
          void onResolve(row.program.id).then(() => { if (alive.current) setDraft(store.draft()); });
        } }]);
      }} /></>}
      {!row.deleted && <><Button label={row.program.name} secondary onPress={() => {
        if (draft) { setError(t.programDraftHint); return; } change(row.program);
      }} /><Button label={t.programDelete} secondary danger onPress={() => remove(row.program)} /></>}
    </Card>)}
  </ScrollView>;
}
