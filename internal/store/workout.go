package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
	"gymbro/internal/workout"
)

var selectAliasTarget = `SELECT exercise_id FROM exercise_aliases WHERE user_id = $1 AND alias_key = ` + norm("$2::text")

const (
	insertWorkout = `INSERT INTO workouts (user_id, performed_on, workout_type, kcal, protein_g, note, raw_text, source, source_ref, started_at, finished_at, name)
		VALUES ($1, $2::text::date, NULLIF($3::text, ''), $4, $5, NULLIF($6::text, ''), $7, $8, $9, $10, $11, $12)`
	deleteEntries = `DELETE FROM workout_exercises WHERE workout_id = $1`
	insertEntry   = `INSERT INTO workout_exercises (workout_id, exercise_id, position, name_as_written)
		VALUES ($1, $2, $3, $4) RETURNING id`
	// Weight travels as text and is cast in SQL, never through float64.
	insertSet = `INSERT INTO exercise_sets (workout_exercise_id, position, weight_kg, reps)
		VALUES ($1, $2, $3::text::numeric, $4)`
)

// CreateWorkout inserts a new workout and its entries in one transaction.
// Source fields are provenance only; repeated creates receive distinct IDs.
func (s *Store) CreateWorkout(ctx context.Context, userID int64, req apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	resp := apiclient.SaveWorkoutResponse{Created: true, NewExercises: []string{}}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, insertWorkout+` RETURNING id, updated_at`,
			userID, req.PerformedOn, canonicalType(req.Type), req.Kcal, req.ProteinG,
			req.Note, req.RawText, req.Source, req.SourceRef, req.StartedAt, req.FinishedAt, effectiveWorkoutName(req.Name, req.Type),
		).Scan(&resp.WorkoutID, &resp.UpdatedAt)
		if err != nil {
			return fmt.Errorf("create workout: %w", err)
		}
		return replaceWorkoutEntries(ctx, tx, userID, req.Entries, &resp)
	})
	if err != nil {
		return apiclient.SaveWorkoutResponse{}, err
	}
	resp.UpdatedAt = resp.UpdatedAt.UTC()
	return resp, nil
}

// resolveExercise applies the resolution order: alias target, exercise by key, new exercise.
func resolveExercise(ctx context.Context, tx pgx.Tx, userID int64, name string) (id int64, created bool, err error) {
	err = tx.QueryRow(ctx, selectAliasTarget, userID, name).Scan(&id)
	if err == nil {
		return id, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, fmt.Errorf("resolve alias: %w", err)
	}
	err = tx.QueryRow(ctx, selectExerciseByName, userID, name).Scan(&id)
	if err == nil {
		return id, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, fmt.Errorf("resolve exercise: %w", err)
	}
	return ensureExercise(ctx, tx, userID, name)
}

// canonicalType returns the spelling from workout.Types matching t case-insensitively,
// or "" when t is empty (stored as NULL). Requests are validated beforehand.
func canonicalType(t string) string {
	for _, known := range workout.Types {
		if strings.EqualFold(t, known) {
			return known
		}
	}
	return ""
}

// replaceWorkoutEntries shares the existing resolver and ordered replacement.
func replaceWorkoutEntries(ctx context.Context, tx pgx.Tx, userID int64, entries []apiclient.Entry, resp *apiclient.SaveWorkoutResponse) error {
	_, err := tx.Exec(ctx, deleteEntries, resp.WorkoutID)
	if err != nil {
		return fmt.Errorf("delete entries: %w", err)
	}

	seen := map[int64]bool{}
	for i, entry := range entries {
		exerciseID, created, err := resolveExercise(ctx, tx, userID, entry.Name)
		if err != nil {
			return err
		}
		// Dedupe by id: a name repeated in one workout is created once.
		if created && !seen[exerciseID] {
			seen[exerciseID] = true
			resp.NewExercises = append(resp.NewExercises, entry.Name)
		}

		var entryID int64
		err = tx.QueryRow(ctx, insertEntry, resp.WorkoutID, exerciseID, i+1, entry.Name).Scan(&entryID)
		if err != nil {
			return fmt.Errorf("insert entry: %w", err)
		}
		for j, set := range entry.Sets {
			_, err = tx.Exec(ctx, insertSet, entryID, j+1, set.Weight, set.Reps)
			if err != nil {
				return fmt.Errorf("insert set: %w", err)
			}
		}
	}
	return nil
}

const (
	updateWorkout = `UPDATE workouts SET performed_on = $3::text::date,
 workout_type = NULLIF($4::text, ''), kcal = $5, protein_g = $6,
 note = NULLIF($7::text, ''), raw_text = $8, started_at = $9, finished_at = $10, name = COALESCE($11::text, ''),
 updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = $1 AND user_id = $2 RETURNING updated_at`
	deleteWorkout = `DELETE FROM workouts WHERE id = $1 AND user_id = $2`
)

// UpdateWorkout replaces all content on an owned row, preserving ID and provenance.
func (s *Store) UpdateWorkout(ctx context.Context, userID, workoutID int64, req apiclient.UpdateWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	resp := apiclient.SaveWorkoutResponse{WorkoutID: workoutID, NewExercises: []string{}}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, updateWorkout, workoutID, userID, req.PerformedOn, canonicalType(req.Type), req.Kcal, req.ProteinG, req.Note, req.RawText, req.StartedAt, req.FinishedAt, trimmedWorkoutName(req.Name)).Scan(&resp.UpdatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return apperr.ErrWorkoutNotFound
		}
		if err != nil {
			return fmt.Errorf("update workout: %w", err)
		}
		return replaceWorkoutEntries(ctx, tx, userID, req.Entries, &resp)
	})
	if err != nil {
		return apiclient.SaveWorkoutResponse{}, err
	}
	resp.UpdatedAt = resp.UpdatedAt.UTC()
	return resp, nil
}

// DeleteWorkout deletes an owned workout and cascades its entries and sets.
func (s *Store) DeleteWorkout(ctx context.Context, userID, workoutID int64) error {
	result, err := s.pool.Exec(ctx, deleteWorkout, workoutID, userID)
	if err != nil {
		return fmt.Errorf("delete workout: %w", err)
	}
	if result.RowsAffected() == 0 {
		return apperr.ErrWorkoutNotFound
	}
	return nil
}

func trimmedWorkoutName(name *string) *string {
	if name == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*name)
	return &trimmed
}

func effectiveWorkoutName(name *string, legacyType string) string {
	if name == nil {
		return canonicalType(legacyType)
	}
	return strings.TrimSpace(*name)
}
