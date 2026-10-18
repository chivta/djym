package store

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gymbro/internal/apiclient"
	"gymbro/internal/apperr"
)

const (
	cursorSep  = ":"
	dateLayout = "2006-01-02"

	// listWorkouts loads one page with entries and sets in a single query: entries
	// and sets are aggregated to JSON per workout, keys matching apiclient tags.
	// ($2::text IS NULL) means first page; otherwise keyset on (performed_on, id).
	// trim_scale renders weights minimally (60.00 -> 60, 13.50 -> 13.5) without float64.
	selectWorkouts = `SELECT w.id, w.name, w.performed_on::text, w.workout_type, w.kcal, w.protein_g, w.note,
			w.started_at, w.finished_at, w.source, w.source_ref, w.raw_text, w.updated_at,
			COALESCE((
				SELECT json_agg(json_build_object(
					'position', we.position,
					'name_as_written', we.name_as_written,
					'exercise', e.name,
					'sets', COALESCE((
						SELECT json_agg(json_build_object('weight', trim_scale(s.weight_kg)::text, 'reps', s.reps) ORDER BY s.position)
						FROM exercise_sets s WHERE s.workout_exercise_id = we.id
					), '[]'::json)
				) ORDER BY we.position)
				FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
				WHERE we.workout_id = w.id
			), '[]'::json)
		FROM workouts w`
	listWorkouts = selectWorkouts + `
		WHERE w.user_id = $1
			AND ($2::text IS NULL OR (w.performed_on, w.id) < ($2::text::date, $3::bigint))
		ORDER BY w.performed_on DESC, w.id DESC
		LIMIT $4`
)

// encodeCursor makes the opaque paging cursor for the last returned workout:
// base64url (unpadded) of "<performed_on>:<id>".
func encodeCursor(performedOn string, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(performedOn + cursorSep + strconv.FormatInt(id, 10)))
}

// decodeCursor reverses encodeCursor; any malformed cursor is apperr.ErrInvalidRequest.
func decodeCursor(cursor string) (performedOn string, id int64, err error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return "", 0, fmt.Errorf("cursor encoding: %w", apperr.ErrInvalidRequest)
	}
	date, idText, found := strings.Cut(string(raw), cursorSep)
	if !found {
		return "", 0, fmt.Errorf("cursor shape: %w", apperr.ErrInvalidRequest)
	}
	_, err = time.Parse(dateLayout, date)
	if err != nil {
		return "", 0, fmt.Errorf("cursor date: %w", apperr.ErrInvalidRequest)
	}
	id, err = strconv.ParseInt(idText, 10, 64)
	if err != nil || id <= 0 {
		return "", 0, fmt.Errorf("cursor id: %w", apperr.ErrInvalidRequest)
	}
	return date, id, nil
}

// ListWorkouts returns up to limit workouts of a user, newest first by
// (performed_on, id), strictly older than the before cursor ("" for the first
// page). NextCursor is set only when older workouts remain. An unknown user
// yields an empty page. Costs one query regardless of page size.
func (s *Store) ListWorkouts(ctx context.Context, userID int64, limit int, before string) (apiclient.ListWorkoutsResponse, error) {
	var beforeDate *string
	var beforeID int64
	if before != "" {
		date, id, err := decodeCursor(before)
		if err != nil {
			return apiclient.ListWorkoutsResponse{}, err
		}
		beforeDate, beforeID = &date, id
	}

	// One extra row tells whether another page exists.
	rows, err := s.pool.Query(ctx, listWorkouts, userID, beforeDate, beforeID, limit+1)
	if err != nil {
		return apiclient.ListWorkoutsResponse{}, fmt.Errorf("list workouts: %w", err)
	}
	defer rows.Close()

	resp := apiclient.ListWorkoutsResponse{Workouts: []apiclient.Workout{}}
	for rows.Next() {
		var w apiclient.Workout
		err = rows.Scan(&w.ID, &w.Name, &w.PerformedOn, &w.Type, &w.Kcal, &w.ProteinG, &w.Note,
			&w.StartedAt, &w.FinishedAt, &w.Source, &w.SourceRef, &w.RawText, &w.UpdatedAt, &w.Entries)
		if err != nil {
			return apiclient.ListWorkoutsResponse{}, fmt.Errorf("scan workout: %w", err)
		}
		w.UpdatedAt = w.UpdatedAt.UTC()
		w.StartedAt = utc(w.StartedAt)
		w.FinishedAt = utc(w.FinishedAt)
		resp.Workouts = append(resp.Workouts, w)
	}
	err = rows.Err()
	if err != nil {
		return apiclient.ListWorkoutsResponse{}, fmt.Errorf("list workouts: %w", err)
	}

	if len(resp.Workouts) > limit {
		resp.Workouts = resp.Workouts[:limit]
		last := resp.Workouts[limit-1]
		cursor := encodeCursor(last.PerformedOn, last.ID)
		resp.NextCursor = &cursor
	}
	return resp, nil
}

// utc converts a non-nil time to UTC so it marshals as RFC 3339 with a Z suffix.
func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}
