package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
	"gymbro/internal/workout"
)

var selectAliasTarget = `SELECT exercise_id FROM exercise_aliases WHERE user_id = $1 AND alias_key = ` + norm("$2::text")

const (
	insertWorkout = `INSERT INTO workouts (user_id, performed_on, workout_type, kcal, protein_g, note, raw_text, source, source_ref, started_at, finished_at)
		VALUES ($1, $2::text::date, NULLIF($3::text, ''), $4, $5, NULLIF($6::text, ''), $7, $8, $9, $10, $11)`
	// upsertWorkout keeps the workout id on conflict and bumps updated_at.
	// Wall-clock time plus a microsecond floor keeps revisions distinct even when
	// concurrent transactions start before waiting for the row lock.
	// xmax = 0 is true only for a freshly inserted row.
	upsertWorkout = insertWorkout + ` ON CONFLICT (user_id, source, source_ref) DO UPDATE SET
			performed_on = EXCLUDED.performed_on,
			workout_type = EXCLUDED.workout_type,
			kcal         = EXCLUDED.kcal,
			protein_g    = EXCLUDED.protein_g,
			note         = EXCLUDED.note,
			raw_text     = EXCLUDED.raw_text,
			started_at   = EXCLUDED.started_at,
			finished_at  = EXCLUDED.finished_at,
			updated_at   = GREATEST(clock_timestamp(), workouts.updated_at + interval '1 microsecond')
		RETURNING id, (xmax = 0), updated_at`

	deleteEntries = `DELETE FROM workout_exercises WHERE workout_id = $1`
	insertEntry   = `INSERT INTO workout_exercises (workout_id, exercise_id, position, name_as_written)
		VALUES ($1, $2, $3, $4) RETURNING id`
	// Weight travels as text and is cast in SQL, never through float64.
	insertSet = `INSERT INTO exercise_sets (workout_exercise_id, position, weight_kg, reps)
		VALUES ($1, $2, $3::text::numeric, $4)`
)

// SaveWorkout upserts a workout on (user, source, source_ref) in one transaction.
// An existing workout keeps its id and has all entries and sets replaced. Entry
// names resolve alias, then exercise, else a new exercise is created; the names
// created by this call are returned.
func (s *Store) SaveWorkout(ctx context.Context, userID int64, req apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	resp := apiclient.SaveWorkoutResponse{NewExercises: []string{}}

	err := s.inTx(ctx, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, upsertWorkout,
			userID, req.PerformedOn, canonicalType(req.Type), req.Kcal, req.ProteinG,
			req.Note, req.RawText, req.Source, req.SourceRef, req.StartedAt, req.FinishedAt,
		).Scan(&resp.WorkoutID, &resp.Created, &resp.UpdatedAt)
		if err != nil {
			return fmt.Errorf("upsert workout: %w", err)
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
	lockWorkout   = `SELECT updated_at FROM workouts WHERE id = $1 AND user_id = $2 FOR UPDATE`
	updateWorkout = `UPDATE workouts SET performed_on = $3::text::date,
 workout_type = NULLIF($4::text, ''), kcal = $5, protein_g = $6,
 note = NULLIF($7::text, ''), raw_text = $8, started_at = $9, finished_at = $10,
 updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')
 WHERE id = $1 AND user_id = $2 RETURNING updated_at`
	deleteWorkout = `DELETE FROM workouts WHERE id = $1 AND user_id = $2`
)

// checkWorkoutRevision locks only an owned row, hiding other users' IDs.
func checkWorkoutRevision(ctx context.Context, tx pgx.Tx, userID, workoutID int64, expected time.Time) error {
	var revision time.Time
	err := tx.QueryRow(ctx, lockWorkout, workoutID, userID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.ErrWorkoutNotFound
	}
	if err != nil {
		return fmt.Errorf("lock workout: %w", err)
	}
	if !revision.Equal(expected) {
		return apperr.ErrConflict
	}
	return nil
}

// UpdateWorkout replaces content under an ownership/revision lock, preserving identity.
func (s *Store) UpdateWorkout(ctx context.Context, userID, workoutID int64, req apiclient.UpdateWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	resp := apiclient.SaveWorkoutResponse{WorkoutID: workoutID, NewExercises: []string{}}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		err := checkWorkoutRevision(ctx, tx, userID, workoutID, req.ExpectedUpdatedAt)
		if err != nil {
			return err
		}
		err = tx.QueryRow(ctx, updateWorkout, workoutID, userID, req.PerformedOn, canonicalType(req.Type), req.Kcal, req.ProteinG, req.Note, req.RawText, req.StartedAt, req.FinishedAt).Scan(&resp.UpdatedAt)
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

// DeleteWorkout cascades entries and sets only after the same revision check.
func (s *Store) DeleteWorkout(ctx context.Context, userID, workoutID int64, expected time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		err := checkWorkoutRevision(ctx, tx, userID, workoutID, expected)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, deleteWorkout, workoutID, userID)
		if err != nil {
			return fmt.Errorf("delete workout: %w", err)
		}
		return nil
	})
}
