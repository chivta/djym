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
)

const (
	createWorkout     = insertWorkout + ` ON CONFLICT (user_id, source, source_ref) DO NOTHING RETURNING id, updated_at`
	lockWorkoutSource = `SELECT id, updated_at FROM workouts WHERE user_id = $1 AND source = $2 AND source_ref = $3 FOR UPDATE`
)

// CreateWorkout admits an owning user's create or identical replay, never an
// unrevisioned replacement. Service saves retain SaveWorkout's upsert behavior.
func (s *Store) CreateWorkout(ctx context.Context, userID int64, req apiclient.SaveWorkoutRequest) (apiclient.SaveWorkoutResponse, error) {
	resp := apiclient.SaveWorkoutResponse{NewExercises: []string{}}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		for {
			err := tx.QueryRow(ctx, createWorkout, userID, req.PerformedOn, canonicalType(req.Type), req.Kcal, req.ProteinG,
				req.Note, req.RawText, req.Source, req.SourceRef, req.StartedAt, req.FinishedAt, effectiveWorkoutName(req.Name, req.Type)).Scan(&resp.WorkoutID, &resp.UpdatedAt)
			if err == nil {
				resp.Created = true
				return replaceWorkoutEntries(ctx, tx, userID, req.Entries, &resp)
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("create workout: %w", err)
			}
			err = tx.QueryRow(ctx, lockWorkoutSource, userID, req.Source, req.SourceRef).Scan(&resp.WorkoutID, &resp.UpdatedAt)
			// A concurrent delete may remove the conflicting row before we lock it.
			if errors.Is(err, pgx.ErrNoRows) {
				continue
			}
			if err != nil {
				return fmt.Errorf("lock create replay: %w", err)
			}
			break
		}
		// Read entries in a fresh statement after acquiring the row lock, so a PUT
		// that committed while we waited cannot leave us comparing an older snapshot.
		var w apiclient.Workout
		err := tx.QueryRow(ctx, selectWorkouts+` WHERE w.id = $1`, resp.WorkoutID).Scan(
			&w.ID, &w.Name, &w.PerformedOn, &w.Type, &w.Kcal, &w.ProteinG, &w.Note,
			&w.StartedAt, &w.FinishedAt, &w.Source, &w.SourceRef, &w.RawText, &w.UpdatedAt, &w.Entries)
		if err != nil {
			return fmt.Errorf("read create replay: %w", err)
		}
		if !sameWorkoutContent(w, req) {
			return apperr.ErrConflict
		}
		return nil
	})
	if err != nil {
		return apiclient.SaveWorkoutResponse{}, err
	}
	resp.UpdatedAt = resp.UpdatedAt.UTC()
	return resp, nil
}

func optionalValue[T comparable](v *T) T {
	var zero T
	if v == nil {
		return zero
	}
	return *v
}

func sameOptionalInt(a, b *int) bool {
	return (a == nil) == (b == nil) && optionalValue(a) == optionalValue(b)
}

func sameOptionalTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	// pgx stores timestamps at Postgres microsecond precision.
	return a.Equal(b.Truncate(time.Microsecond))
}

func decimalWeight(s string) string {
	parts := strings.SplitN(s, ".", 2)
	whole := strings.TrimLeft(parts[0], "0")
	if whole == "" {
		whole = "0"
	}
	if len(parts) == 2 {
		fraction := strings.TrimRight(parts[1], "0")
		if fraction != "" {
			return whole + "." + fraction
		}
	}
	return whole
}

func sameWorkoutContent(w apiclient.Workout, req apiclient.SaveWorkoutRequest) bool {
	if w.Name != effectiveWorkoutName(req.Name, req.Type) || w.PerformedOn != req.PerformedOn || optionalValue(w.Type) != canonicalType(req.Type) ||
		!sameOptionalInt(w.Kcal, req.Kcal) || !sameOptionalInt(w.ProteinG, req.ProteinG) ||
		optionalValue(w.Note) != req.Note || w.RawText != req.RawText ||
		!sameOptionalTime(w.StartedAt, req.StartedAt) || !sameOptionalTime(w.FinishedAt, req.FinishedAt) || len(w.Entries) != len(req.Entries) {
		return false
	}
	for i, e := range w.Entries {
		requested := req.Entries[i]
		if e.NameAsWritten != requested.Name || len(e.Sets) != len(requested.Sets) {
			return false
		}
		for j, set := range e.Sets {
			if set.Reps != requested.Sets[j].Reps || decimalWeight(set.Weight) != decimalWeight(requested.Sets[j].Weight) {
				return false
			}
		}
	}
	return true
}
