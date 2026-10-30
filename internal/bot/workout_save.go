package bot

import (
	"context"
	"errors"
	"fmt"
	"time"

	"gymbro/internal/apiclient"
)

var (
	errWorkoutState    = errors.New("workout state unavailable")
	errWorkoutRecovery = errors.New("previously saved workout cannot be identified")
)

// saveWorkout chooses POST only for a new message, PUT for a known target.
// d.mu is held by the caller. Provenance is only used to recover pre-CRUD bot
// state for previously saved messages, never to make POST idempotent.
func (b *Bot) saveWorkout(ctx context.Context, userID, chatID int64, msgID int, d *draft, req apiclient.SaveWorkoutRequest, firstSaved time.Time, known bool) (apiclient.SaveWorkoutResponse, error) {
	id := d.WorkoutID
	if id == 0 {
		id = d.SavedWorkoutID // drafts written by the previous version
	}
	if id == 0 {
		var err error
		id, err = b.state.WorkoutID(ctx, chatID, msgID)
		if err != nil {
			return apiclient.SaveWorkoutResponse{}, fmt.Errorf("%w: %v", errWorkoutState, err)
		}
	}
	if id == 0 && known {
		var err error
		id, err = b.recoverWorkoutID(ctx, userID, req.Source, req.SourceRef)
		if err != nil {
			return apiclient.SaveWorkoutResponse{}, err
		}
	}
	// Retain recovered IDs even when PUT fails; a deleted target must not turn
	// a later button press into POST.
	d.WorkoutID = id
	var resp apiclient.SaveWorkoutResponse
	var err error
	if id == 0 {
		resp, err = b.api.CreateWorkout(ctx, userID, req)
	} else {
		resp, err = b.api.UpdateWorkout(ctx, userID, id, apiclient.UpdateWorkoutRequest{
			PerformedOn: req.PerformedOn, Name: req.Name, Type: req.Type, Kcal: req.Kcal,
			ProteinG: req.ProteinG, Note: req.Note, RawText: req.RawText, Entries: req.Entries,
			StartedAt: req.StartedAt, FinishedAt: req.FinishedAt,
		})
	}
	if err != nil {
		return apiclient.SaveWorkoutResponse{}, err
	}
	d.WorkoutID = resp.WorkoutID
	if err := b.state.SetWorkoutSave(ctx, chatID, msgID, resp.WorkoutID, firstSaved); err != nil {
		return resp, fmt.Errorf("%w: %v", errWorkoutState, err)
	}
	return resp, nil
}

// Historical recovery scans at most 1000 workouts. A complete scan must find
// exactly one match; partial or ambiguous results never select an edit target.
func (b *Bot) recoverWorkoutID(ctx context.Context, userID int64, source, ref string) (int64, error) {
	var id int64
	cursor := ""
	for page := 0; page < 10; page++ {
		resp, err := b.api.ListWorkouts(ctx, userID, 100, cursor)
		if err != nil {
			return 0, err
		}
		for _, w := range resp.Workouts {
			if w.Source == source && w.SourceRef == ref {
				if id != 0 {
					return 0, errWorkoutRecovery
				}
				id = w.ID
			}
		}
		if resp.NextCursor == nil {
			if id == 0 {
				return 0, errWorkoutRecovery
			}
			return id, nil
		}
		cursor = *resp.NextCursor
	}
	return 0, errWorkoutRecovery
}
